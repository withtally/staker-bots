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

export class ProfitabilityEngineWrapper implements IProfitabilityEngine {
  private engine: IProfitabilityEngine;

  constructor(
    db: IDatabase,
    provider: ethers.Provider,
    stakerAddress: string,
    config: ProfitabilityConfig = {
      minProfitMargin: BigInt(1e16), // 0.01 ETH
      maxBatchSize: 10,
      gasPriceBuffer: 20, // 20% buffer
      minConfidence: 90,
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
    this.engine = new BaseProfitabilityEngine(
      calculator,
      stakerContract,
      provider,
      config,
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
