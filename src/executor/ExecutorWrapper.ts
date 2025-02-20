import { ethers } from 'ethers';
import { BaseExecutor } from './strategies/BaseExecutor';
import {
  ExecutorConfig,
  QueuedTransaction,
  QueueStats,
  TransactionReceipt,
} from './interfaces/types';
import { DEFAULT_EXECUTOR_CONFIG } from './constants';
import { ProfitabilityCheck } from '@/profitability/interfaces/types';

export class ExecutorWrapper {
  private executor: BaseExecutor;

  constructor(
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    config: Partial<ExecutorConfig> = {},
  ) {
    // Merge provided config with defaults
    const fullConfig: ExecutorConfig = {
      ...DEFAULT_EXECUTOR_CONFIG,
      ...config,
      wallet: {
        ...DEFAULT_EXECUTOR_CONFIG.wallet,
        ...config.wallet,
      },
    };

    this.executor = new BaseExecutor(stakerContract, provider, fullConfig);
  }

  /**
   * Start the executor
   */
  async start(): Promise<void> {
    await this.executor.start();
  }

  /**
   * Stop the executor
   */
  async stop(): Promise<void> {
    await this.executor.stop();
  }

  /**
   * Get the current status of the executor
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    return this.executor.getStatus();
  }

  /**
   * Queue a transaction for execution
   */
  async queueTransaction(
    depositId: bigint,
    profitability: ProfitabilityCheck,
  ): Promise<QueuedTransaction> {
    return this.executor.queueTransaction(depositId, profitability);
  }

  /**
   * Get statistics about the transaction queue
   */
  async getQueueStats(): Promise<QueueStats> {
    return this.executor.getQueueStats();
  }

  /**
   * Get a specific transaction by ID
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.executor.getTransaction(id);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    return this.executor.getTransactionReceipt(hash);
  }

  /**
   * Transfer accumulated tips to the configured receiver
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    return this.executor.transferOutTips();
  }

  /**
   * Clear the transaction queue
   */
  async clearQueue(): Promise<void> {
    await this.executor.clearQueue();
  }
}
