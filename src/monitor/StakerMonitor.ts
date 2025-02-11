import { ethers } from 'ethers';
import { IDatabase } from '@/database';
import { EventProcessor } from './EventProcessor';
import { ConsoleLogger, Logger } from './logging';
import {
  MonitorConfig,
  MonitorStatus,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
} from './types';
import { STAKER_ABI } from './constants';

export class StakerMonitor {
  private readonly db: IDatabase;
  private readonly provider: ethers.Provider;
  private readonly contract: ethers.Contract;
  private readonly logger: Logger;
  private readonly eventProcessor: EventProcessor;
  private readonly config: MonitorConfig;
  private isRunning: boolean;
  private processingPromise?: Promise<void>;
  private lastProcessedBlock: number;

  constructor(config: MonitorConfig) {
    this.config = config;
    this.db = config.database;
    this.provider = config.provider;
    this.contract = new ethers.Contract(
      config.stakerAddress,
      STAKER_ABI,
      config.provider,
    );
    this.logger = new ConsoleLogger(config.logLevel);
    this.eventProcessor = new EventProcessor(this.db, this.logger);
    this.isRunning = false;
    this.lastProcessedBlock = config.startBlock;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Monitor is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting Staker Monitor', {
      network: this.config.networkName,
      chainId: this.config.chainId,
      address: this.config.stakerAddress,
    });

    // Always start from the configured start block
    this.lastProcessedBlock = this.config.startBlock;
    this.logger.info('Starting from block', {
      blockNumber: this.lastProcessedBlock,
    });

    this.processingPromise = this.processLoop();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.processingPromise) {
      await this.processingPromise;
    }
    this.logger.info('Staker Monitor stopped');
  }

  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentBlock = await this.getCurrentBlock();
        const targetBlock = currentBlock - this.config.confirmations;

        if (targetBlock <= this.lastProcessedBlock) {
          this.logger.debug('Waiting for new blocks', {
            currentBlock,
            targetBlock,
            lastProcessedBlock: this.lastProcessedBlock,
          });
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.pollInterval * 1000),
          );
          continue;
        }

        const fromBlock = this.lastProcessedBlock + 1;
        const toBlock = Math.min(
          targetBlock,
          fromBlock + this.config.maxBlockRange - 1,
        );

        this.logger.info('Processing new blocks', {
          fromBlock,
          toBlock,
          currentBlock,
          blockRange: toBlock - fromBlock + 1,
        });

        await this.processBlockRange(fromBlock, toBlock);

        const block = await this.provider.getBlock(toBlock);
        if (!block) throw new Error(`Block ${toBlock} not found`);

        // Update checkpoint
        await this.db.updateCheckpoint({
          component_type: 'staker-monitor',
          last_block_number: toBlock,
          block_hash: block.hash!,
          last_update: new Date().toISOString(),
        });

        this.lastProcessedBlock = toBlock;
        this.logger.info('Blocks processed successfully', {
          fromBlock,
          toBlock,
          blockHash: block.hash,
        });
      } catch (error) {
        this.logger.error('Error in processing loop', {
          error,
          lastProcessedBlock: this.lastProcessedBlock,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.pollInterval * 1000),
        );
      }
    }
  }

  private async processBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    this.logger.info('Querying events for block range', { fromBlock, toBlock });

    const [depositedEvents, withdrawnEvents, alteredEvents] = await Promise.all([
      this.contract.queryFilter(
        this.contract.filters.StakeDeposited!(),
        fromBlock,
        toBlock,
      ),
      this.contract.queryFilter(
        this.contract.filters.StakeWithdrawn!(),
        fromBlock,
        toBlock,
      ),
      this.contract.queryFilter(
        this.contract.filters.DelegateeAltered!(),
        fromBlock,
        toBlock,
      ),
    ]);

    this.logger.info('Events found', {
      depositedCount: depositedEvents.length,
      withdrawnCount: withdrawnEvents.length,
      alteredCount: alteredEvents.length,
      blockRange: `${fromBlock}-${toBlock}`,
    });

    // Process events in order
    for (const event of depositedEvents) {
      const typedEvent = event as ethers.EventLog;
      const { depositId, owner: ownerAddress, amount } = typedEvent.args;
      this.logger.debug('Processing StakeDeposited event', {
        depositId: depositId.toString(),
        ownerAddress,
        amount: amount.toString(),
        blockNumber: typedEvent.blockNumber,
        txHash: typedEvent.transactionHash,
      });
      await this.handleStakeDeposited({
        depositId: depositId.toString(),
        ownerAddress,
        delegateeAddress: ownerAddress,
        amount,
        blockNumber: typedEvent.blockNumber!,
        transactionHash: typedEvent.transactionHash!,
      });
    }

    for (const event of withdrawnEvents) {
      const typedEvent = event as ethers.EventLog;
      const { depositId, amount } = typedEvent.args;
      this.logger.debug('Processing StakeWithdrawn event', {
        depositId: depositId.toString(),
        amount: amount.toString(),
        blockNumber: typedEvent.blockNumber,
        txHash: typedEvent.transactionHash,
      });
      await this.handleStakeWithdrawn({
        depositId: depositId.toString(),
        withdrawnAmount: amount,
        blockNumber: typedEvent.blockNumber!,
        transactionHash: typedEvent.transactionHash!,
      });
    }

    for (const event of alteredEvents) {
      const typedEvent = event as ethers.EventLog;
      const { depositId, oldDelegatee, newDelegatee } = typedEvent.args;
      this.logger.debug('Processing DelegateeAltered event', {
        depositId,
        oldDelegatee,
        newDelegatee,
        blockNumber: typedEvent.blockNumber,
        txHash: typedEvent.transactionHash,
      });
      await this.handleDelegateeAltered({
        depositId,
        oldDelegatee,
        newDelegatee,
        blockNumber: typedEvent.blockNumber!,
        transactionHash: typedEvent.transactionHash!,
      });
    }
  }

  async handleStakeDeposited(event: StakeDepositedEvent): Promise<void> {
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      const result = await this.eventProcessor.processStakeDeposited(event);
      if (result.success || !result.retryable) {
        return;
      }
      attempts++;
      if (attempts < this.config.maxRetries) {
        this.logger.warn(
          `Retrying StakeDeposited event (attempt ${attempts + 1}/${this.config.maxRetries})`,
          { event },
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts)); // Exponential backoff
      }
    }
    this.logger.error(
      'Failed to process StakeDeposited event after max retries',
      { event },
    );
  }

  async handleStakeWithdrawn(event: StakeWithdrawnEvent): Promise<void> {
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      const result = await this.eventProcessor.processStakeWithdrawn(event);
      if (result.success || !result.retryable) {
        return;
      }
      attempts++;
      if (attempts < this.config.maxRetries) {
        this.logger.warn(
          `Retrying StakeWithdrawn event (attempt ${attempts + 1}/${this.config.maxRetries})`,
          { event },
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
    this.logger.error(
      'Failed to process StakeWithdrawn event after max retries',
      { event },
    );
  }

  async handleDelegateeAltered(event: DelegateeAlteredEvent): Promise<void> {
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      const result = await this.eventProcessor.processDelegateeAltered(event);
      if (result.success || !result.retryable) {
        return;
      }
      attempts++;
      if (attempts < this.config.maxRetries) {
        this.logger.warn(
          `Retrying DelegateeAltered event (attempt ${attempts + 1}/${this.config.maxRetries})`,
          { event },
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
    this.logger.error(
      'Failed to process DelegateeAltered event after max retries',
      { event },
    );
  }

  async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async getLastProcessedBlock(): Promise<number> {
    return this.lastProcessedBlock;
  }

  async getMonitorStatus(): Promise<MonitorStatus> {
    const currentBlock = await this.getCurrentBlock();
    const checkpoint = await this.db.getCheckpoint('staker-monitor');

    return {
      isRunning: this.isRunning,
      lastProcessedBlock: this.lastProcessedBlock,
      currentChainBlock: currentBlock,
      processingLag: currentBlock - this.lastProcessedBlock,
      lastCheckpoint: checkpoint!,
      networkStatus: {
        chainId: this.config.chainId,
        networkName: this.config.networkName,
        isConnected: true, // You might want to implement a more sophisticated check
      },
    };
  }

  async getProcessingLag(): Promise<number> {
    const currentBlock = await this.getCurrentBlock();
    return currentBlock - this.lastProcessedBlock;
  }
}
