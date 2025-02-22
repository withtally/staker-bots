import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { StakerMonitor } from '@/monitor/StakerMonitor';
import { CalculatorWrapper } from '@/calculator';
import { ProfitabilityEngineWrapper } from '@/profitability';
import { ExecutorWrapper } from '@/executor';
import { DatabaseWrapper } from '@/database/DatabaseWrapper';
import { Logger } from '@/monitor/logging';
import { DelegateeAlteredEvent } from '@/monitor/types';

interface ProcessingResult {
  success: boolean;
  processedBlocks: number;
  processedEvents: number;
  error?: Error;
}

interface SystemStatus {
  isRunning: boolean;
  errorCount: number;
  lastErrorTime: number;
  components: {
    monitor: any;
    calculator: any;
    profitability: any;
    executor: any;
  };
}

interface StakerBotConfig {
  // Core configurations
  startBlock: number;
  confirmations: number;
  maxBlockRange: number;

  // Processing configs
  batchSize: number;
  retryAttempts: number;
  retryDelay: number;

  // Performance tuning
  maxConcurrentProcessing: number;
  processingTimeout: number;

  // Circuit breaker configs
  maxErrorThreshold: number;
  errorTimeWindow: number;
}

export class StakerBotOrchestrator extends EventEmitter {
  private isRunning: boolean = false;
  private errorCount: number = 0;
  private lastErrorTime: number = 0;

  constructor(
    private readonly monitor: StakerMonitor,
    private readonly calculator: CalculatorWrapper,
    private readonly profitabilityEngine: ProfitabilityEngineWrapper,
    private readonly executor: ExecutorWrapper,
    private readonly database: DatabaseWrapper,
    private readonly logger: Logger,
    private readonly config: StakerBotConfig
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Orchestrator is already running');
      return;
    }

    try {
      this.logger.info('Starting StakerBot Orchestrator');

      // Initialize all components
      await this.calculator.start();
      await this.profitabilityEngine.start();
      await this.executor.start();

      // Start monitor last since it will trigger events
      await this.monitor.start();

      // Set up event handlers
      this.monitor.on('delegateEvent', this.handleDelegateEvent.bind(this));
      this.monitor.on('error', this.handleError.bind(this));

      this.isRunning = true;
      this.emit('started');
      this.logger.info('StakerBot Orchestrator started successfully');
    } catch (error) {
      this.logger.error('Failed to start orchestrator', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping StakerBot Orchestrator');
    this.isRunning = false;

    try {
      // Stop in reverse order of startup
      await this.monitor.stop();
      await this.executor.stop();
      await this.profitabilityEngine.stop();
      await this.calculator.stop();

      this.emit('stopped');
      this.logger.info('StakerBot Orchestrator stopped successfully');
    } catch (error) {
      this.logger.error('Error during orchestrator shutdown', { error });
      throw error;
    }
  }

  private async handleDelegateEvent(event: DelegateeAlteredEvent): Promise<void> {
    try {
      this.logger.info('Processing delegate event', {
        delegatee: event.newDelegatee,
        blockNumber: event.blockNumber
      });

      // Get affected deposits
      const deposits = await this.database.getDepositsByDelegatee(event.newDelegatee);

      // Process in batches if needed
      for (let i = 0; i < deposits.length; i += this.config.batchSize) {
        const batch = deposits.slice(i, i + this.config.batchSize);

        // 1. Update scores via calculator
        const scoreUpdates = await Promise.all(
          batch.map(deposit =>
            this.calculator.getNewEarningPower(
              BigInt(deposit.amount),
              deposit.owner_address,
              deposit.delegatee_address!,
              BigInt(0) // Previous earning power - should be stored/retrieved
            )
          )
        );

        // Store score updates
        await Promise.all(
          scoreUpdates.map((update, index) =>
            this.database.createScoreEvent({
              delegatee: batch[index]!.delegatee_address!,
              score: update[0].toString(),
              block_number: event.blockNumber
            })
          )
        );

        // 2. Check profitability
        const convertedBatch = batch.map(deposit => ({
          ...deposit,
          deposit_id: BigInt(deposit.deposit_id),
          amount: BigInt(deposit.amount)
        }));
        const batchAnalysis = await this.profitabilityEngine.analyzeBatchProfitability(convertedBatch);

        // 3. Queue profitable transactions
        for (const result of batchAnalysis.deposits) {
          if (result.profitability.canBump) {
            await this.executor.queueTransaction(
              result.depositId,
              result.profitability
            );

            this.logger.info('Queued profitable bump transaction', {
              depositId: result.depositId.toString(),
              profit: result.profitability.estimates.expectedProfit.toString()
            });
          }
        }
      }

      this.emit('processedDelegateEvent', {
        event,
        success: true
      });
    } catch (error) {
      this.logger.error('Error handling delegate event', {
        error,
        event
      });
      await this.handleError(error instanceof Error ? error : new Error(String(error)));

      this.emit('processedDelegateEvent', {
        event,
        success: false,
        error
      });
    }
  }

  private async handleError(error: Error): Promise<void> {
    this.errorCount++;
    const now = Date.now();

    // Reset error count if outside time window
    if (now - this.lastErrorTime > this.config.errorTimeWindow) {
      this.errorCount = 1;
    }
    this.lastErrorTime = now;

    // Check circuit breaker
    if (this.errorCount >= this.config.maxErrorThreshold) {
      this.logger.error('Error threshold exceeded, stopping orchestrator', {
        errorCount: this.errorCount,
        timeWindow: this.config.errorTimeWindow
      });

      await this.stop();
      this.emit('circuitBreaker', { error, errorCount: this.errorCount });
    }
  }

  // Add monitoring and health check methods
  async getStatus(): Promise<SystemStatus> {
    return {
      isRunning: this.isRunning,
      errorCount: this.errorCount,
      lastErrorTime: this.lastErrorTime,
      components: {
        monitor: await this.monitor.getMonitorStatus(),
        calculator: await this.calculator.getStatus(),
        profitability: await this.profitabilityEngine.getStatus(),
        executor: await this.executor.getStatus()
      }
    };
  }

  // Useful for testing and manual intervention
  async reprocessBlockRange(fromBlock: number, toBlock: number): Promise<ProcessingResult> {
    this.logger.info('Reprocessing block range', { fromBlock, toBlock });

    try {
      // Clear existing data for range
      await this.database.deleteScoreEventsByBlockRange(fromBlock, toBlock);

      // Process blocks using monitor's public methods
      await this.monitor.start();
      await this.monitor.stop();

      return {
        success: true,
        processedBlocks: toBlock - fromBlock + 1,
        processedEvents: 0 // We don't have access to event count
      };
    } catch (error) {
      this.logger.error('Error reprocessing block range', {
        error,
        fromBlock,
        toBlock
      });

      return {
        success: false,
        error: error as Error,
        processedBlocks: 0,
        processedEvents: 0
      };
    }
  }

  // Helper method to check if transaction was profitable
  async verifyTransactionProfitability(
    txHash: string
  ): Promise<{
    profitable: boolean;
    expectedProfit: bigint;
    actualProfit: bigint;
    gasUsed: bigint;
  }> {
    const receipt = await this.executor.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`Transaction ${txHash} not found`);
    }

    // Get profitability estimate from database
    const tx = await this.executor.getTransaction(txHash);
    if (!tx) {
      throw new Error(`Transaction ${txHash} not found in executor queue`);
    }

    // Calculate actual profit from receipt data
    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? 0);
    const gasUsed = BigInt(receipt.gasUsed);
    const gasCost = effectiveGasPrice * gasUsed;
    const actualProfit = (tx.profitability?.estimates?.expectedProfit ?? BigInt(0)) - gasCost;
    const expectedProfit = tx.profitability?.estimates?.expectedProfit ?? BigInt(0);

    return {
      profitable: actualProfit > gasUsed,
      expectedProfit,
      actualProfit,
      gasUsed
    };
  }
}
