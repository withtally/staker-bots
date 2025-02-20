import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { ExecutorWrapper } from '@/executor';
import { ProfitabilityEngineWrapper } from '@/profitability';
import { DatabaseWrapper } from '@/database';

export class ProfitabilityExecutorService {
  private readonly logger: Logger;
  private isRunning: boolean;
  private processingInterval: NodeJS.Timeout | null;

  constructor(
    private readonly profitabilityEngine: ProfitabilityEngineWrapper,
    private readonly executor: ExecutorWrapper,
    private readonly database: DatabaseWrapper,
    private readonly pollInterval: number = 15000, // Default to 15 seconds
  ) {
    this.logger = new ConsoleLogger('info');
    this.isRunning = false;
    this.processingInterval = null;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('ProfitabilityExecutorService started');

    // Start both components
    await this.profitabilityEngine.start();
    await this.executor.start();

    // Start processing loop
    this.processingInterval = setInterval(
      () => this.processDeposits(),
      this.pollInterval,
    );

    // Process immediately on start
    await this.processDeposits();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Stop both components
    await this.profitabilityEngine.stop();
    await this.executor.stop();

    this.logger.info('ProfitabilityExecutorService stopped');
  }

  private async processDeposits(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Get all deposits from the database
      const deposits = await this.database.getAllDeposits();
      if (!deposits.length) {
        return;
      }

      // Convert database deposits to profitability engine format
      const profitabilityDeposits = deposits.map(deposit => ({
        deposit_id: BigInt(deposit.deposit_id),
        owner_address: deposit.owner_address,
        delegatee_address: deposit.delegatee_address,
        amount: BigInt(deposit.amount),
        created_at: deposit.created_at,
        updated_at: deposit.updated_at,
      }));

      // Analyze batch profitability
      const batchAnalysis = await this.profitabilityEngine.analyzeBatchProfitability(
        profitabilityDeposits,
      );

      // Queue profitable transactions
      for (const result of batchAnalysis.deposits) {
        if (result.profitability.canBump) {
          try {
            await this.executor.queueTransaction(
              result.depositId,
              result.profitability,
            );
            this.logger.info('Queued profitable transaction:', {
              depositId: result.depositId.toString(),
              expectedProfit: ethers.formatEther(
                result.profitability.estimates.expectedProfit,
              ),
            });
          } catch (error) {
            if ((error as Error).message === 'Queue is full') {
              this.logger.warn('Transaction queue is full, waiting for next cycle');
              break;
            }
            this.logger.error('Error queueing transaction:', {
              error,
              depositId: result.depositId.toString(),
            });
          }
        }
      }
    } catch (error) {
      this.logger.error('Error processing deposits:', { error });
    }
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    profitabilityEngine: {
      isRunning: boolean;
      lastGasPrice: bigint;
      lastUpdateTimestamp: number;
    };
    executor: {
      isRunning: boolean;
      walletBalance: bigint;
      pendingTransactions: number;
      queueSize: number;
    };
  }> {
    const [profitabilityStatus, executorStatus] = await Promise.all([
      this.profitabilityEngine.getStatus(),
      this.executor.getStatus(),
    ]);

    return {
      isRunning: this.isRunning,
      profitabilityEngine: profitabilityStatus,
      executor: executorStatus,
    };
  }
}
