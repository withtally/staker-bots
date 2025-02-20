import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IExecutor } from '../interfaces/IExecutor';
import {
  ExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
} from '../interfaces/types';
import { ProfitabilityCheck } from '@/profitability/interfaces/types';
import { v4 as uuidv4 } from 'uuid';

export class BaseExecutor implements IExecutor {
  protected readonly logger: Logger;
  protected readonly wallet: ethers.Wallet;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;

  constructor(
    protected readonly stakerContract: ethers.Contract,
    protected readonly provider: ethers.Provider,
    protected readonly config: ExecutorConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.wallet = new ethers.Wallet(config.wallet.privateKey, provider);
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;

    if (!provider) {
      throw new Error('Provider is required');
    }

    // Validate staker contract
    if (!this.stakerContract.interface.hasFunction('bumpEarningPower')) {
      throw new Error(
        'Invalid staker contract: missing bumpEarningPower function',
      );
    }
  }

  protected async getWalletBalance(): Promise<bigint> {
    return (await this.provider.getBalance(this.wallet.address)) || BigInt(0);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Executor started');

    // Start processing queue periodically as a backup
    this.processingInterval = setInterval(
      () => this.processQueue(true),
      5000, // Process queue every 5 seconds as a backup
    );
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

    this.logger.info('Executor stopped');
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    const balance = await this.getWalletBalance();
    const pendingTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    ).length;

    return {
      isRunning: this.isRunning,
      walletBalance: balance,
      pendingTransactions: pendingTxs,
      queueSize: this.queue.size,
    };
  }

  async queueTransaction(
    depositId: bigint,
    profitability: ProfitabilityCheck,
  ): Promise<QueuedTransaction> {
    // Check queue size
    if (this.queue.size >= this.config.maxQueueSize) {
      throw new Error('Queue is full');
    }

    // Create transaction object
    const tx: QueuedTransaction = {
      id: uuidv4(),
      depositId,
      profitability,
      status: TransactionStatus.QUEUED,
      createdAt: new Date(),
    };

    // Add to queue
    this.queue.set(tx.id, tx);
    this.logger.info('Transaction queued:', {
      id: tx.id,
      depositId: tx.depositId.toString(),
    });

    // Process queue immediately if running
    if (this.isRunning) {
      // Use setImmediate to avoid blocking the current call stack
      setImmediate(() => this.processQueue(false));
    }

    return tx;
  }

  async getQueueStats(): Promise<QueueStats> {
    const txs = Array.from(this.queue.values());
    const confirmedTxs = txs.filter(
      (tx) => tx.status === TransactionStatus.CONFIRMED,
    );

    const totalProfits = confirmedTxs.reduce(
      (sum, tx) => sum + tx.profitability.estimates.expectedProfit,
      BigInt(0),
    );

    const avgGasPrice =
      confirmedTxs.length > 0
        ? confirmedTxs.reduce(
            (sum, tx) => sum + (tx.gasPrice || BigInt(0)),
            BigInt(0),
          ) / BigInt(confirmedTxs.length)
        : BigInt(0);

    const avgExecTime =
      confirmedTxs.length > 0
        ? confirmedTxs.reduce((sum, tx) => {
            const execTime = tx.executedAt
              ? tx.executedAt.getTime() - tx.createdAt.getTime()
              : 0;
            return sum + execTime;
          }, 0) / confirmedTxs.length
        : 0;

    return {
      totalQueued: txs.filter((tx) => tx.status === TransactionStatus.QUEUED)
        .length,
      totalPending: txs.filter((tx) => tx.status === TransactionStatus.PENDING)
        .length,
      totalConfirmed: confirmedTxs.length,
      totalFailed: txs.filter((tx) => tx.status === TransactionStatus.FAILED)
        .length,
      averageExecutionTime: avgExecTime,
      averageGasPrice: avgGasPrice,
      totalProfits,
    };
  }

  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt) {
      return null;
    }

    return {
      hash: receipt.hash,
      status: receipt.status === 1,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice || BigInt(0),
    };
  }

  async transferOutTips(): Promise<TransactionReceipt | null> {
    const balance = await this.getWalletBalance();
    if (balance < this.config.transferOutThreshold) {
      return null;
    }

    try {
      // Calculate transfer amount (leave some ETH for gas)
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || BigInt(0);
      const gasLimit = BigInt(21000); // Standard ETH transfer
      const gasCost = gasLimit * gasPrice;
      const transferAmount = balance - gasCost;

      // Send transaction
      const tx = await this.wallet.sendTransaction({
        to: this.config.wallet.privateKey,
        value: transferAmount,
        gasLimit,
      });

      // Wait for confirmation
      const receipt = await tx.wait(this.config.minConfirmations);
      if (!receipt) {
        throw new Error('Failed to get transaction receipt');
      }

      return {
        hash: receipt.hash,
        status: receipt.status === 1,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.gasPrice || BigInt(0),
      };
    } catch (error) {
      this.logger.error('Error transferring tips:', { error });
      throw error;
    }
  }

  async clearQueue(): Promise<void> {
    this.queue.clear();
    this.logger.info('Queue cleared');
  }

  protected async processQueue(
    isPeriodicCheck: boolean = false,
  ): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Check wallet balance
      const balance = await this.getWalletBalance();
      if (balance < this.config.wallet.minBalance) {
        this.logger.warn('Wallet balance too low:', {
          balance: ethers.formatEther(balance),
          minimum: ethers.formatEther(this.config.wallet.minBalance),
        });
        return;
      }

      // Get pending transactions count
      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      );
      if (pendingTxs.length >= this.config.wallet.maxPendingTransactions) {
        return;
      }

      // Get queued transactions
      const queuedTxs = Array.from(this.queue.values())
        .filter((tx) => tx.status === TransactionStatus.QUEUED)
        .slice(0, this.config.concurrentTransactions - pendingTxs.length);

      if (queuedTxs.length === 0) {
        if (!isPeriodicCheck) {
          this.logger.debug('No queued transactions to process');
        }
        return;
      }

      // Process each transaction
      await Promise.all(queuedTxs.map((tx) => this.executeTransaction(tx)));
    } catch (error) {
      this.logger.error('Error processing queue:', { error });
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    try {
      // Update status to pending
      tx.status = TransactionStatus.PENDING;
      this.queue.set(tx.id, tx);

      // Get current gas price and apply boost
      const feeData = await this.provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || BigInt(0);
      const boostMultiplier =
        BigInt(100 + this.config.gasBoostPercentage) / BigInt(100);
      const gasPrice = baseGasPrice * boostMultiplier;

      // Prepare transaction
      const bumpTx =
        await this.stakerContract.bumpEarningPower?.populateTransaction(
          tx.depositId,
          tx.profitability.estimates.optimalTip,
        );

      // Send transaction
      const response = await this.wallet.sendTransaction({
        ...bumpTx,
        gasPrice,
        value: tx.profitability.estimates.optimalTip,
      });

      // Update transaction
      tx.hash = response.hash;
      tx.gasPrice = gasPrice;
      tx.executedAt = new Date();
      this.queue.set(tx.id, tx);

      // Wait for confirmation
      const receipt = await response.wait(this.config.minConfirmations);
      if (!receipt) {
        throw new Error('Failed to get transaction receipt');
      }

      // Update final status
      tx.status =
        receipt.status === 1
          ? TransactionStatus.CONFIRMED
          : TransactionStatus.FAILED;
      this.queue.set(tx.id, tx);

      this.logger.info('Transaction executed:', {
        id: tx.id,
        hash: tx.hash,
        status: tx.status,
      });
    } catch (error) {
      tx.status = TransactionStatus.FAILED;
      tx.error = error as Error;
      this.queue.set(tx.id, tx);
      this.logger.error('Error executing transaction:', {
        error,
        id: tx.id,
      });
    }
  }
}
