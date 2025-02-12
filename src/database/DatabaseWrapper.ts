import { IDatabase } from './interfaces/IDatabase';
import { Deposit, ProcessingCheckpoint, ScoreEvent } from './interfaces/types';
import * as supabaseDb from './supabase/deposits';
import * as supabaseCheckpoints from './supabase/checkpoints';
import * as supabaseScoreEvents from './supabase/score_events';
import { JsonDatabase } from './json/JsonDatabase';

export type DatabaseConfig = {
  type: 'supabase' | 'json';
  jsonDbPath?: string;
};

export class DatabaseWrapper implements IDatabase {
  private db: IDatabase;

  constructor(config: DatabaseConfig = { type: 'supabase' }) {
    if (config.type === 'json') {
      this.db = new JsonDatabase(config.jsonDbPath);
    } else {
      this.db = {
        createDeposit: supabaseDb.createDeposit,
        updateDeposit: supabaseDb.updateDeposit,
        deleteDeposit: supabaseDb.deleteDeposit,
        getDeposit: supabaseDb.getDeposit,
        getDepositsByDelegatee: supabaseDb.getDepositsByDelegatee,
        updateCheckpoint: supabaseCheckpoints.updateCheckpoint,
        getCheckpoint: supabaseCheckpoints.getCheckpoint,
        createScoreEvent: supabaseScoreEvents.createScoreEvent,
        updateScoreEvent: supabaseScoreEvents.updateScoreEvent,
        deleteScoreEvent: supabaseScoreEvents.deleteScoreEvent,
        getScoreEvent: supabaseScoreEvents.getScoreEvent,
        getLatestScoreEvent: supabaseScoreEvents.getLatestScoreEvent,
        getScoreEventsByBlockRange:
          supabaseScoreEvents.getScoreEventsByBlockRange,
        deleteScoreEventsByBlockRange:
          supabaseScoreEvents.deleteScoreEventsByBlockRange,
      };
    }
  }

  // Deposits
  async createDeposit(deposit: Deposit): Promise<void> {
    return this.db.createDeposit(deposit);
  }

  async updateDeposit(
    depositId: string,
    update: Partial<Omit<Deposit, 'deposit_id'>>,
  ): Promise<void> {
    return this.db.updateDeposit(depositId, update);
  }

  async deleteDeposit(depositId: string): Promise<void> {
    return this.db.deleteDeposit(depositId);
  }

  async getDeposit(depositId: string): Promise<Deposit | null> {
    return this.db.getDeposit(depositId);
  }

  async getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]> {
    return this.db.getDepositsByDelegatee(delegateeAddress);
  }

  // Checkpoints
  async updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    return this.db.updateCheckpoint(checkpoint);
  }

  async getCheckpoint(
    componentType: string,
  ): Promise<ProcessingCheckpoint | null> {
    return this.db.getCheckpoint(componentType);
  }

  // Score Events
  async createScoreEvent(event: ScoreEvent): Promise<void> {
    return this.db.createScoreEvent(event);
  }

  async updateScoreEvent(
    delegatee: string,
    blockNumber: number,
    update: Partial<ScoreEvent>,
  ): Promise<void> {
    return this.db.updateScoreEvent(delegatee, blockNumber, update);
  }

  async deleteScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<void> {
    return this.db.deleteScoreEvent(delegatee, blockNumber);
  }

  async getScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<ScoreEvent | null> {
    return this.db.getScoreEvent(delegatee, blockNumber);
  }

  async getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null> {
    return this.db.getLatestScoreEvent(delegatee);
  }

  async getScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]> {
    return this.db.getScoreEventsByBlockRange(fromBlock, toBlock);
  }

  async deleteScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    return this.db.deleteScoreEventsByBlockRange(fromBlock, toBlock);
  }
}
