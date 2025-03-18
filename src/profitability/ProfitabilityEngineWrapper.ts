import { ethers } from 'ethers';
import { IDatabase } from '@/database';
import { BinaryEligibilityOracleEarningPowerCalculator } from '@/calculator';
import { IProfitabilityEngine } from './interfaces/IProfitabilityEngine';
import { BaseProfitabilityEngine } from './strategies/BaseProfitabilityEngine';
import {
  BatchAnalysis,
  Deposit,
  ProfitabilityCheck,
  ProfitabilityConfig,
} from './interfaces/types';
import { STAKER_ABI } from './constants';
import { CONFIG } from '@/config';
import { CoinMarketCapFeed } from '@/shared/price-feeds/coinmarketcap/CoinMarketCapFeed';
import { Logger } from '@/monitor/logging';

export class ProfitabilityEngineWrapper implements IProfitabilityEngine {
  private engine: IProfitabilityEngine;

  constructor(
    db: IDatabase,
    provider: ethers.Provider,
    stakerAddress: string,
    logger: Logger,
    config: ProfitabilityConfig = {
      minProfitMargin: BigInt(1e16), // 0.01 ETH
      maxBatchSize: 10,
      gasPriceBuffer: 20, // 20% buffer
      rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
      priceFeed: {
        cacheDuration: 10 * 60 * 1000, // 10 minutes
      },
      defaultTipReceiver: stakerAddress, // Default to staker contract address
    },
  ) {
    // Initialize calculator
    const calculator = new BinaryEligibilityOracleEarningPowerCalculator(
      db,
      provider,
    );

    // Initialize staker contract
    const stakerContract = new ethers.Contract(
      stakerAddress,
      STAKER_ABI,
      provider,
    );

    // Initialize base engine
    // Cast contract to expected type
    const typedContract = stakerContract as ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
      maxBumpTip(): Promise<bigint>;
      bumpEarningPower(
        depositId: bigint,
        tipReceiver: string,
        tip: bigint,
      ): Promise<bigint>;
      REWARD_TOKEN(): Promise<string>;
    };

    // Initialize price feed
    const priceFeed = new CoinMarketCapFeed(
      {
        ...CONFIG.priceFeed.coinmarketcap,
        arbTestTokenAddress: CONFIG.monitor.arbTestTokenAddress,
        arbRealTokenAddress: CONFIG.monitor.arbRealTokenAddress,
      },
      logger,
    );

    this.engine = new BaseProfitabilityEngine(
      calculator,
      typedContract,
      provider,
      config,
      priceFeed,
    );
  }

  async start(): Promise<void> {
    return this.engine.start();
  }

  async stop(): Promise<void> {
    return this.engine.stop();
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
  }> {
    return this.engine.getStatus();
  }

  async checkProfitability(deposit: Deposit): Promise<ProfitabilityCheck> {
    return this.engine.checkProfitability(deposit);
  }

  async analyzeBatchProfitability(deposits: Deposit[]): Promise<BatchAnalysis> {
    return this.engine.analyzeBatchProfitability(deposits);
  }
}
