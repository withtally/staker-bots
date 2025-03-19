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
import { ProcessingQueueStatus, TransactionQueueStatus } from '@/database/interfaces/types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Helper function to serialize BigInt values in an object for JSON.stringify
 * Converts all BigInt values to strings with their type for deserialization
 */
function serializeBigInts(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return { type: 'bigint', value: obj.toString() };
  }

  if (Array.isArray(obj)) {
    return obj.map(item => serializeBigInts(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const key in obj) {
      result[key] = serializeBigInts(obj[key]);
    }
    return result;
  }

  return obj;
}

/**
 * Helper function to deserialize BigInt values from a serialized object
 * Converts all serialized BigInt objects back to actual BigInt values
 */
function deserializeBigInts(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'object' && !Array.isArray(obj) && obj.type === 'bigint' && 'value' in obj) {
    return BigInt(obj.value);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deserializeBigInts(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const key in obj) {
      result[key] = deserializeBigInts(obj[key]);
    }
    return result;
  }

  return obj;
}

export class ProfitabilityEngineWrapper implements IProfitabilityEngine {
  private engine: IProfitabilityEngine;
  private db: IDatabase;
  private logger: Logger;
  private isRunning: boolean = false;
  private delegateeQueue: Map<string, Set<string>> = new Map(); // Track deposits by delegatee (string depositId)
  private processingQueue: Set<string> = new Set(); // Global processing queue (string depositId)
  private queueProcessorInterval: NodeJS.Timeout | null = null;
  private calculator: BinaryEligibilityOracleEarningPowerCalculator;
  private executor: any; // Will be set later via setExecutor method
  private provider: ethers.Provider;
  private stakerAddress: string;
  private config: ProfitabilityConfig;
  private priceFeed: CoinMarketCapFeed;
  private stakerContract: ethers.Contract & {
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
    this.db = db;
    this.logger = logger;
    this.provider = provider;
    this.stakerAddress = stakerAddress;
    this.config = config;

    // Initialize calculator
    this.calculator = new BinaryEligibilityOracleEarningPowerCalculator(
      db,
      provider,
    );

    // Initialize staker contract
    const stakerContract = new ethers.Contract(
      stakerAddress,
      STAKER_ABI,
      provider,
    );

    // Cast contract to expected type
    this.stakerContract = stakerContract as ethers.Contract & {
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
    this.priceFeed = new CoinMarketCapFeed(
      {
        ...CONFIG.priceFeed.coinmarketcap,
        arbTestTokenAddress: CONFIG.monitor.arbTestTokenAddress,
        arbRealTokenAddress: CONFIG.monitor.arbRealTokenAddress,
      },
      logger,
    );

    this.engine = new BaseProfitabilityEngine(
      this.calculator,
      this.stakerContract,
      provider,
      config,
      this.priceFeed,
    );
  }

  /**
   * Set the executor instance to be used for queueing transactions
   */
  setExecutor(executor: any): void {
    this.executor = executor;
    this.logger.info('Executor set for profitability engine');
  }

  /**
   * Start the profitability engine and queue processor
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    await this.engine.start();
    this.isRunning = true;

    // Start queue processor
    this.startQueueProcessor();

    // Requeue any pending items from the database
    await this.requeuePendingItems();

    this.logger.info('Profitability engine started with queue processor');
  }

  /**
   * Stop the profitability engine and queue processor
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    await this.engine.stop();
    this.isRunning = false;

    // Stop queue processor
    this.stopQueueProcessor();

    this.logger.info('Profitability engine stopped');
  }

  /**
   * Requeue any pending items from previous runs
   */
  private async requeuePendingItems(): Promise<void> {
    try {
      // Get all pending or processing items that might have been interrupted
      const pendingItems = await this.db.getProcessingQueueItemsByStatus(ProcessingQueueStatus.PENDING);
      const processingItems = await this.db.getProcessingQueueItemsByStatus(ProcessingQueueStatus.PROCESSING);

      const allItems = [...pendingItems, ...processingItems];

      if (allItems.length === 0) {
        this.logger.debug('No pending items to requeue');
        return;
      }

      this.logger.info(`Requeuing ${allItems.length} pending items from previous runs`);

      // Requeue each item
      for (const item of allItems) {
        // Add to delegatee queue
        if (!this.delegateeQueue.has(item.delegatee)) {
          this.delegateeQueue.set(item.delegatee, new Set());
        }

        this.delegateeQueue.get(item.delegatee)?.add(item.deposit_id);
        this.processingQueue.add(item.deposit_id);

        // Update status to pending
        await this.db.updateProcessingQueueItem(item.id, {
          status: ProcessingQueueStatus.PENDING,
          error: undefined, // Clear any previous errors
        });
      }

      this.logger.info(`Requeued ${allItems.length} items`);
    } catch (error) {
      this.logger.error('Error requeuing pending items', { error });
    }
  }

  /**
   * Start the queue processor interval
   */
  private startQueueProcessor(): void {
    if (this.queueProcessorInterval) return;

    this.queueProcessorInterval = setInterval(() => {
      this.processQueue().catch(error => {
        this.logger.error('Error in queue processor', { error });
      });
    }, 30000); // Process queue every 30 seconds

    this.logger.info('Queue processor started');
  }

  /**
   * Stop the queue processor interval
   */
  private stopQueueProcessor(): void {
    if (this.queueProcessorInterval) {
      clearInterval(this.queueProcessorInterval);
      this.queueProcessorInterval = null;
      this.logger.info('Queue processor stopped');
    }
  }

  /**
   * Handle score event for a delegatee by queueing all their deposits for processing
   */
  async onScoreEvent(delegatee: string, newScore: bigint): Promise<void> {
    try {
      this.logger.info('Score event received for delegatee', {
        delegatee,
        newScore: newScore.toString(),
        currentQueueSize: this.processingQueue.size,
        delegateeQueueSize: this.delegateeQueue.size
      });

      // Get all deposits for this delegatee
      const deposits = await this.db.getDepositsByDelegatee(delegatee);

      if (deposits.length === 0) {
        this.logger.debug('No deposits found for delegatee', { delegatee });
        return;
      }

      this.logger.info('Found deposits for delegatee', {
        delegatee,
        depositCount: deposits.length,
        depositIds: deposits.map(d => d.deposit_id).join(', ')
      });

      // Initialize set if not exists
      if (!this.delegateeQueue.has(delegatee)) {
        this.delegateeQueue.set(delegatee, new Set());
      }

      // Add deposits to database processing queue and in-memory queues
      for (const deposit of deposits) {
        // Check if already in queue
        const existing = await this.db.getProcessingQueueItemByDepositId(deposit.deposit_id);
        if (existing && [ProcessingQueueStatus.PENDING, ProcessingQueueStatus.PROCESSING].includes(existing.status as ProcessingQueueStatus)) {
          this.logger.debug(`Deposit ${deposit.deposit_id} already in queue with status ${existing.status}`);
          continue;
        }

        // Create a new queue item in the database
        await this.db.createProcessingQueueItem({
          deposit_id: deposit.deposit_id,
          delegatee: delegatee,
          status: ProcessingQueueStatus.PENDING,
        });

        // Add to in-memory queues
        this.delegateeQueue.get(delegatee)?.add(deposit.deposit_id);
        this.processingQueue.add(deposit.deposit_id);

        this.logger.debug(`Added deposit ${deposit.deposit_id} to processing queue`);
      }

      this.logger.info('Deposits queued for processing', {
        delegatee,
        depositCount: deposits.length,
        queueSize: this.processingQueue.size,
        depositIds: Array.from(this.delegateeQueue.get(delegatee) || []).join(', ')
      });

      // Process queue immediately if size is small
      if (this.processingQueue.size <= 10) {
        this.processQueue().catch(error => {
          this.logger.error('Error processing queue after score event', { error });
        });
      }
    } catch (error) {
      this.logger.error('Error handling score event', { delegatee, error });
    }
  }

  /**
   * Process the global queue of deposits for profitability checks
   */
  async processQueue(): Promise<void> {
    if (this.processingQueue.size === 0) {
      this.logger.debug('Processing queue is empty');
      return;
    }

    if (!this.executor) {
      this.logger.warn('No executor set, skipping queue processing');
      return;
    }

    const queueCopy = Array.from(this.processingQueue);
    this.logger.info('Processing profitability queue', {
      queueSize: queueCopy.length,
      queueItems: queueCopy.join(', ')
    });

    // Process in batches of 10 to avoid overloading
    const batchSize = 10;
    const batches = Math.ceil(queueCopy.length / batchSize);

    for (let i = 0; i < batches; i++) {
      const batchStart = i * batchSize;
      const batchEnd = Math.min((i + 1) * batchSize, queueCopy.length);
      const batch = queueCopy.slice(batchStart, batchEnd);

      this.logger.debug(`Processing batch ${i + 1}/${batches}`, {
        batchSize: batch.length
      });

      const deposits: Deposit[] = [];
      const queueItems: Map<string, string> = new Map(); // depositId -> queueItemId

      // Collect deposits for batch and update status
      for (const depositId of batch) {
        try {
          // Find the queue item
          const queueItem = await this.db.getProcessingQueueItemByDepositId(depositId);
          if (!queueItem) {
            this.logger.warn('Queue item not found for deposit', { depositId });
            this.processingQueue.delete(depositId);
            continue;
          }

          // Update status to processing
          await this.db.updateProcessingQueueItem(queueItem.id, {
            status: ProcessingQueueStatus.PROCESSING,
            attempts: queueItem.attempts + 1,
          });

          // Get the deposit
          const deposit = await this.db.getDeposit(depositId);
          if (!deposit) {
            this.logger.warn('Deposit not found', { depositId });

            // Mark as failed
            await this.db.updateProcessingQueueItem(queueItem.id, {
              status: ProcessingQueueStatus.FAILED,
              error: 'Deposit not found in database',
            });

            this.processingQueue.delete(depositId);
            continue;
          }

          // Map queue item ID to deposit ID for later
          queueItems.set(depositId, queueItem.id);

          // Convert deposit to the format expected by profitability engine
          deposits.push({
            deposit_id: BigInt(deposit.deposit_id),
            owner_address: deposit.owner_address,
            delegatee_address: deposit.delegatee_address || '',
            amount: BigInt(deposit.amount),
            created_at: deposit.created_at,
            updated_at: deposit.updated_at,
          });
        } catch (error) {
          this.logger.error('Error preparing deposit for processing', {
            depositId,
            error
          });

          // Remove from processing queue to avoid endless loop
          this.processingQueue.delete(depositId);
        }
      }

      if (deposits.length === 0) {
        this.logger.debug('No valid deposits in batch, skipping');
        continue;
      }

      try {
        // Analyze batch profitability
        const batchAnalysis = await this.analyzeBatchProfitability(deposits);

        // Process profitable deposits
        for (const result of batchAnalysis.deposits) {
          const depositId = result.depositId.toString();
          const queueItemId = queueItems.get(depositId);

          if (!queueItemId) {
            this.logger.warn('Queue item ID not found for deposit result', { depositId });
            continue;
          }

          // Remove from queues regardless of profitability to avoid reprocessing
          this.processingQueue.delete(depositId);

          for (const [delegatee, depositsSet] of this.delegateeQueue.entries()) {
            if (depositsSet.has(depositId)) {
              depositsSet.delete(depositId);
              if (depositsSet.size === 0) {
                this.delegateeQueue.delete(delegatee);
              }
              break;
            }
          }

          // Save profitability check result
          await this.db.updateProcessingQueueItem(queueItemId, {
            last_profitability_check: JSON.stringify(serializeBigInts(result.profitability)),
          });

          if (result.profitability.canBump) {
            try {
              // Queue transaction for execution
              const txResult = await this.executor.queueTransaction(
                result.depositId,
                result.profitability,
              );

              // Create transaction queue item
              await this.db.createTransactionQueueItem({
                deposit_id: depositId,
                status: TransactionQueueStatus.PENDING,
                tx_data: JSON.stringify(serializeBigInts({
                  depositId: result.depositId.toString(),
                  profitability: result.profitability,
                })),
                tip_amount: result.profitability.estimates.optimalTip.toString(),
                tip_receiver: result.profitability.estimates.tipReceiver,
              });

              // Mark processing queue item as completed
              await this.db.updateProcessingQueueItem(queueItemId, {
                status: ProcessingQueueStatus.COMPLETED,
              });

              this.logger.info('Transaction queued for deposit', {
                depositId,
                txId: txResult.id,
                expectedProfit: ethers.formatEther(
                  result.profitability.estimates.expectedProfit,
                ),
                optimalTip: ethers.formatEther(
                  result.profitability.estimates.optimalTip,
                ),
              });
            } catch (error) {
              this.logger.error('Error queueing transaction', {
                depositId,
                error
              });

              // Mark as failed
              await this.db.updateProcessingQueueItem(queueItemId, {
                status: ProcessingQueueStatus.FAILED,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            // Check if it's profitable but just not eligible or doesn't have enough rewards
            const isProfitable = result.profitability.constraints.isProfitable;

            if (isProfitable) {
              // Update the profitability check but keep as pending for future checks
              await this.db.updateProcessingQueueItem(queueItemId, {
                last_profitability_check: JSON.stringify(serializeBigInts(result.profitability)),
                status: ProcessingQueueStatus.PENDING
              });

              // Add back to the processing queue with a small delay (will be picked up in next run)
              setTimeout(() => {
                if (this.isRunning) {
                  this.processingQueue.add(depositId);

                  // Also add back to delegatee queue
                  const depositInfo = this.db.getDeposit(depositId).then(deposit => {
                    if (!deposit) return;

                    const delegatee = deposit.delegatee_address;
                    if (delegatee) {
                      if (!this.delegateeQueue.has(delegatee)) {
                        this.delegateeQueue.set(delegatee, new Set());
                      }
                      this.delegateeQueue.get(delegatee)?.add(depositId);
                    }
                  }).catch(error => {
                    this.logger.error('Error getting deposit info for requeue', { depositId, error });
                  });

                  this.logger.debug('Deposit is profitable but not yet eligible/enough rewards, kept as pending', {
                    depositId,
                    canBump: result.profitability.canBump,
                    constraints: result.profitability.constraints
                  });
                }
              }, 5 * 60 * 1000); // Check again in 5 minutes

              // Remove from current processing queue but will be added back by the timeout
              this.processingQueue.delete(depositId);
            } else {
              // Not profitable, mark as completed
              await this.db.updateProcessingQueueItem(queueItemId, {
                status: ProcessingQueueStatus.COMPLETED,
                last_profitability_check: JSON.stringify(serializeBigInts(result.profitability))
              });

              this.logger.debug('Deposit not profitable, marked as completed', {
                depositId,
                canBump: result.profitability.canBump,
                constraints: result.profitability.constraints
              });
            }
          }
        }
      } catch (error) {
        this.logger.error('Error processing batch', { error, batchSize: deposits.length });

        // Mark all items in the batch as failed
        for (const [depositId, queueItemId] of queueItems.entries()) {
          await this.db.updateProcessingQueueItem(queueItemId, {
            status: ProcessingQueueStatus.FAILED,
            error: error instanceof Error ? error.message : String(error),
          });

          // Remove from processing queue
          this.processingQueue.delete(depositId);
        }
      }
    }

    this.logger.info('Queue processing completed', {
      remainingItems: this.processingQueue.size
    });
  }

  /**
   * Get the current status of the profitability engine
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    delegateeCount: number;
  }> {
    const baseStatus = await this.engine.getStatus();

    return {
      ...baseStatus,
      queueSize: this.processingQueue.size,
      delegateeCount: this.delegateeQueue.size,
    };
  }

  /**
   * Get statistics about the queues
   */
  async getQueueStats(): Promise<{
    totalDelegatees: number;
    totalDeposits: number;
    delegateeBreakdown: Record<string, number>;
    pendingCount: number;
    processingCount: number;
    completedCount: number;
    failedCount: number;
  }> {
    const delegateeBreakdown: Record<string, number> = {};

    for (const [delegatee, depositsSet] of this.delegateeQueue.entries()) {
      delegateeBreakdown[delegatee] = depositsSet.size;
    }

    // Get counts from database
    const pendingItems = await this.db.getProcessingQueueItemsByStatus(ProcessingQueueStatus.PENDING);
    const processingItems = await this.db.getProcessingQueueItemsByStatus(ProcessingQueueStatus.PROCESSING);
    const completedItems = await this.db.getProcessingQueueItemsByStatus(ProcessingQueueStatus.COMPLETED);
    const failedItems = await this.db.getProcessingQueueItemsByStatus(ProcessingQueueStatus.FAILED);

    return {
      totalDelegatees: this.delegateeQueue.size,
      totalDeposits: this.processingQueue.size,
      delegateeBreakdown,
      pendingCount: pendingItems.length,
      processingCount: processingItems.length,
      completedCount: completedItems.length,
      failedCount: failedItems.length,
    };
  }

  // Original methods
  async checkProfitability(deposit: Deposit): Promise<ProfitabilityCheck> {
    return this.engine.checkProfitability(deposit);
  }

  async analyzeBatchProfitability(deposits: Deposit[]): Promise<BatchAnalysis> {
    return this.engine.analyzeBatchProfitability(deposits);
  }
}
