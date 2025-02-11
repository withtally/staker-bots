import { IDatabase } from '@/database';
import {
  ProcessingResult,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
} from './types';
import { Logger } from './logging';

export class EventProcessor {
  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
  ) {}

  async processStakeDeposited(
    event: StakeDepositedEvent,
  ): Promise<ProcessingResult> {
    try {
      await this.db.createDeposit({
        deposit_id: event.depositId,
        owner_address: event.ownerAddress,
        delegatee_address: event.delegateeAddress,
        amount: Number(event.amount)
      });

      return {
        success: true,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: false,
      };
    } catch (error) {
      this.logger.error('Failed to process StakeDeposited event', {
        error,
        event,
      });

      return {
        success: false,
        error: error as Error,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: true,
      };
    }
  }

  async processStakeWithdrawn(
    event: StakeWithdrawnEvent,
  ): Promise<ProcessingResult> {
    try {
      const deposit = await this.db.getDeposit(event.depositId);
      if (!deposit) {
        throw new Error(`Deposit ${event.depositId} not found`);
      }

      const remainingAmount = deposit.amount - event.withdrawnAmount;

      if (remainingAmount <= 0) {
        await this.db.deleteDeposit(event.depositId);
      } else {
        await this.db.updateDeposit(event.depositId, { amount: remainingAmount });
      }

      return {
        success: true,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: false,
      };
    } catch (error) {
      this.logger.error('Failed to process StakeWithdrawn event', {
        error,
        event,
      });

      return {
        success: false,
        error: error as Error,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: true,
      };
    }
  }

  async processDelegateeAltered(
    event: DelegateeAlteredEvent,
  ): Promise<ProcessingResult> {
    try {
      await this.db.updateDeposit(
        event.depositId,
        { delegatee_address: event.newDelegatee }
      );

      return {
        success: true,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: false,
      };
    } catch (error) {
      this.logger.error('Failed to process DelegateeAltered event', {
        error,
        event,
      });

      return {
        success: false,
        error: error as Error,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: true,
      };
    }
  }
}
