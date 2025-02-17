import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine';
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

  constructor(
    protected readonly calculator: BinaryEligibilityOracleEarningPowerCalculator,
    protected readonly stakerContract: ethers.Contract,
    protected readonly provider: ethers.Provider,
    protected readonly config: ProfitabilityConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.isRunning = false;
    this.lastGasPrice = BigInt(0);
    this.lastUpdateTimestamp = 0;

    // Validate staker contract
    if (!this.stakerContract.interface.hasFunction('bumpEarningPower')) {
      throw new Error(
        'Invalid staker contract: missing bumpEarningPower function',
      );
    }
  }

  async start(): Promise<void> {
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
      const deposits = this.stakerContract['deposits'] as (
        depositId: string,
      ) => Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;

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
      const gasPrice = await this.getGasPriceWithBuffer();

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
    const [newEarningPower, isEligible] =
      await this.calculator.getNewEarningPower(
        deposit.amount,
        deposit.owner_address,
        deposit.delegatee_address,
        deposit.earning_power || BigInt(0),
      );

    try {
      // Get unclaimed rewards and max tip
      const unclaimedReward = this.stakerContract['unclaimedReward'] as (
        depositId: string,
      ) => Promise<bigint>;
      const maxBumpTip = this.stakerContract[
        'maxBumpTip'
      ] as () => Promise<bigint>;

      const unclaimedRewards = await unclaimedReward(deposit.deposit_id);
      const maxBumpTipValue = await maxBumpTip();

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
      // Estimate gas cost for bump operation
      const estimateGas = this.stakerContract.estimateGas as unknown as {
        bumpEarningPower: (depositId: string, tip: number) => Promise<bigint>;
      };
      const maxBumpTip = this.stakerContract[
        'maxBumpTip'
      ] as () => Promise<bigint>;

      const gasEstimate = await estimateGas.bumpEarningPower(
        deposit.deposit_id,
        0,
      );
      const maxBumpTipValue = await maxBumpTip();

      // Calculate base cost
      const baseCost = gasEstimate * gasPrice;

      // Calculate optimal tip based on gas cost and minimum profit margin
      // Ensure tip doesn't exceed maxBumpTip
      const maxTip = BigInt(maxBumpTipValue.toString());
      const desiredTip = baseCost + this.config.minProfitMargin;
      const optimalTip = desiredTip > maxTip ? maxTip : desiredTip;
      const expectedProfit = optimalTip - baseCost;

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
