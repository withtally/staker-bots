import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine';
import { IPriceFeed } from '@/shared/price-feeds/interfaces';
import {
  BatchAnalysis,
  BumpRequirements,
  Deposit,
  ProfitabilityCheck,
  ProfitabilityConfig,
  TipOptimization,
} from '../interfaces/types';
import { BinaryEligibilityOracleEarningPowerCalculator } from '@/calculator';

export class BaseProfitabilityEngine implements IProfitabilityEngine {
  protected readonly logger: Logger;
  protected isRunning: boolean;
  protected lastGasPrice: bigint;
  protected lastUpdateTimestamp: number;
  protected rewardTokenAddress: string;

  constructor(
    protected readonly calculator: BinaryEligibilityOracleEarningPowerCalculator,
    protected readonly stakerContract: ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
      maxBumpTip(): Promise<bigint>;
      bumpEarningPower(depositId: bigint, tip: bigint): Promise<bigint>;
      REWARD_TOKEN(): Promise<string>;
    },
    protected readonly provider: ethers.Provider,
    protected readonly config: ProfitabilityConfig,
    protected readonly priceFeed: IPriceFeed,
  ) {
    this.logger = new ConsoleLogger('info');
    this.isRunning = false;
    this.lastGasPrice = BigInt(0);
    this.lastUpdateTimestamp = 0;
    this.rewardTokenAddress = '';

    // Validate staker contract
    if (!this.stakerContract.interface.hasFunction('bumpEarningPower')) {
      throw new Error(
        'Invalid staker contract: missing bumpEarningPower function',
      );
    }
  }

  async start(): Promise<void> {
    this.rewardTokenAddress = await this.stakerContract.REWARD_TOKEN();
    this.isRunning = true;
    this.logger.info('Profitability engine started');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.info('Profitability engine stopped');
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
  }> {
    return {
      isRunning: this.isRunning,
      lastGasPrice: this.lastGasPrice,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
    };
  }

  async checkProfitability(deposit: Deposit): Promise<ProfitabilityCheck> {
    try {
      // Validate deposit exists by checking owner
      const deposits = this.stakerContract.deposits;
      const depositInfo = await deposits(deposit.deposit_id);
      if (!depositInfo.owner) {
        this.logger.error('Deposit does not exist:', {
          depositId: deposit.deposit_id,
        });
        return this.createFailedProfitabilityCheck('calculatorEligible');
      }

      // Check bump requirements
      const requirements = await this.validateBumpRequirements(deposit);
      if (!requirements.isEligible) {
        return this.createFailedProfitabilityCheck('calculatorEligible');
      }

      // Calculate optimal tip
      const tipOptimization = await this.calculateOptimalTip(
        deposit,
        await this.getGasPriceWithBuffer(),
      );

      // Check unclaimed rewards rules based on earning power change
      const isEarningPowerIncrease =
        requirements.newEarningPower > deposit.earning_power!;

      if (isEarningPowerIncrease) {
        // For power increases: unclaimedRewards must be >= requestedTip
        if (requirements.unclaimedRewards < tipOptimization.optimalTip) {
          return this.createFailedProfitabilityCheck('hasEnoughRewards');
        }
      } else {
        // For power decreases: (unclaimedRewards - requestedTip) must be >= maxBumpTip
        if (
          requirements.unclaimedRewards - tipOptimization.optimalTip <
          requirements.maxBumpTip
        ) {
          return this.createFailedProfitabilityCheck('hasEnoughRewards');
        }
      }

      // Check if operation is profitable
      const isProfitable =
        tipOptimization.expectedProfit >= this.config.minProfitMargin;
      if (!isProfitable) {
        return this.createFailedProfitabilityCheck('isProfitable');
      }

      return {
        canBump: true,
        constraints: {
          calculatorEligible: true,
          hasEnoughRewards: true,
          isProfitable: true,
        },
        estimates: {
          optimalTip: tipOptimization.optimalTip,
          gasEstimate: tipOptimization.gasEstimate,
          expectedProfit: tipOptimization.expectedProfit,
          tipReceiver: this.config.defaultTipReceiver,
        },
      };
    } catch (error) {
      this.logger.error('Error checking profitability:', {
        error,
        depositId: deposit.deposit_id,
      });
      throw error;
    }
  }

  async analyzeBatchProfitability(deposits: Deposit[]): Promise<BatchAnalysis> {
    try {
      // Limit batch size
      const batchDeposits = deposits.slice(0, this.config.maxBatchSize);
      // Analyze each deposit
      const results = await Promise.all(
        batchDeposits.map(async (deposit) => ({
          depositId: deposit.deposit_id,
          profitability: await this.checkProfitability(deposit),
        })),
      );

      // Filter profitable deposits
      const profitableDeposits = results.filter(
        (result) => result.profitability.canBump,
      );

      // Calculate batch metrics
      const totalGasEstimate = profitableDeposits.reduce(
        (sum, result) => sum + result.profitability.estimates.gasEstimate,
        BigInt(0),
      );

      const totalExpectedProfit = profitableDeposits.reduce(
        (sum, result) => sum + result.profitability.estimates.expectedProfit,
        BigInt(0),
      );

      // Determine optimal batch size based on gas costs and profits
      const recommendedBatchSize = this.calculateOptimalBatchSize(
        profitableDeposits.length,
        totalGasEstimate,
        totalExpectedProfit,
      );

      return {
        deposits: results,
        totalGasEstimate,
        totalExpectedProfit,
        recommendedBatchSize,
      };
    } catch (error) {
      this.logger.error('Error analyzing batch profitability:', { error });
      throw error;
    }
  }

  protected async validateBumpRequirements(
    deposit: Deposit,
  ): Promise<BumpRequirements> {
    // Get current and potential new earning power
    this.logger.info('Checking bump requirements for deposit:', {
      id: deposit.deposit_id.toString(),
      amount: ethers.formatEther(deposit.amount),
      earning_power: deposit.earning_power
        ? ethers.formatEther(deposit.earning_power)
        : 'undefined',
      owner: deposit.owner_address,
      delegatee: deposit.delegatee_address,
    });

    const [newEarningPower, isEligible] =
      await this.calculator.getNewEarningPower(
        deposit.amount,
        deposit.owner_address,
        deposit.delegatee_address!,
        deposit.earning_power || BigInt(0),
      );

    this.logger.info('Calculator results:', {
      newEarningPower: ethers.formatEther(newEarningPower),
      isEligible,
    });

    try {
      // Get unclaimed rewards and max tip
      const unclaimedRewards = await this.stakerContract.unclaimedReward(
        deposit.deposit_id,
      );
      const maxBumpTipValue = await this.stakerContract.maxBumpTip();

      this.logger.info('Contract values:', {
        unclaimedRewards: ethers.formatEther(unclaimedRewards),
        maxBumpTip: ethers.formatEther(maxBumpTipValue),
      });

      return {
        isEligible,
        newEarningPower,
        unclaimedRewards: BigInt(unclaimedRewards.toString()),
        maxBumpTip: BigInt(maxBumpTipValue.toString()),
      };
    } catch (error) {
      this.logger.error('Error getting staker contract values:', { error });
      throw error;
    }
  }

  protected async calculateOptimalTip(
    deposit: Deposit,
    gasPrice: bigint,
  ): Promise<TipOptimization> {
    try {
      // Get max tip value first to use as the value for gas estimation
      const maxBumpTipValue = await this.stakerContract.maxBumpTip();

      // Check if the deposit is eligible for a bump
      const requirements = await this.validateBumpRequirements(deposit);
      if (!requirements.isEligible) {
        return {
          optimalTip: BigInt(0),
          expectedProfit: BigInt(0),
          gasEstimate: BigInt(0),
        };
      }

      // Estimate gas cost for bump operation using the provider
      const gasEstimate = await this.provider.estimateGas({
        to: this.stakerContract.target,
        data: this.stakerContract.interface.encodeFunctionData(
          'bumpEarningPower',
          [BigInt(deposit.deposit_id), BigInt(0)],
        ),
        value: maxBumpTipValue, // Include value for payable function
      });

      // Calculate base cost in wei
      const baseCost = gasEstimate * gasPrice;

      // Get token price and convert base cost to token terms
      const baseCostInToken = await this.priceFeed.getTokenPriceInWei(
        this.rewardTokenAddress,
        baseCost,
      );

      // Calculate optimal tip based on gas cost and minimum profit margin
      // Ensure tip doesn't exceed maxBumpTip
      const maxTip = BigInt(maxBumpTipValue.toString());
      const desiredTip = baseCostInToken + this.config.minProfitMargin;
      const optimalTip = desiredTip > maxTip ? maxTip : desiredTip;
      const expectedProfit = optimalTip - baseCostInToken;

      return {
        optimalTip,
        expectedProfit,
        gasEstimate: BigInt(gasEstimate.toString()),
      };
    } catch (error) {
      this.logger.error('Error calculating optimal tip:', { error });
      throw error;
    }
  }

  protected async getGasPriceWithBuffer(): Promise<bigint> {
    const feeData = await this.provider.getFeeData();
    if (!feeData.gasPrice) {
      throw new Error('Failed to get gas price');
    }

    const baseGasPrice = BigInt(feeData.gasPrice.toString());
    const buffer =
      (baseGasPrice * BigInt(this.config.gasPriceBuffer)) / BigInt(100);

    this.lastGasPrice = baseGasPrice + buffer;
    this.lastUpdateTimestamp = Date.now();

    return this.lastGasPrice;
  }

  protected calculateOptimalBatchSize(
    availableDeposits: number,
    totalGasEstimate: bigint,
    totalExpectedProfit: bigint,
  ): number {
    // Simple optimization: if profit per deposit decreases as batch size increases,
    // reduce batch size until profit per deposit is maximized
    const profitPerDeposit = totalExpectedProfit / BigInt(availableDeposits);
    const gasPerDeposit = totalGasEstimate / BigInt(availableDeposits);

    // Start with maximum available deposits
    let optimalSize = availableDeposits;

    // Reduce batch size if profit per deposit is too low
    while (
      optimalSize > 1 &&
      profitPerDeposit < gasPerDeposit * BigInt(2) // Minimum 2x profit/gas ratio
    ) {
      optimalSize--;
    }

    return Math.min(optimalSize, this.config.maxBatchSize);
  }

  private createFailedProfitabilityCheck(
    failedConstraint: keyof ProfitabilityCheck['constraints'],
  ): ProfitabilityCheck {
    return {
      canBump: false,
      constraints: {
        calculatorEligible: failedConstraint !== 'calculatorEligible',
        hasEnoughRewards: failedConstraint !== 'hasEnoughRewards',
        isProfitable: failedConstraint !== 'isProfitable',
      },
      estimates: {
        optimalTip: BigInt(0),
        gasEstimate: BigInt(0),
        expectedProfit: BigInt(0),
        tipReceiver: this.config.defaultTipReceiver,
      },
    };
  }
}
