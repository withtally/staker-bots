import { IDatabase } from './interfaces/IDatabase';
import { Deposit, ProcessingCheckpoint } from './interfaces/types';
import * as supabaseDb from './supabase/deposits';
import * as supabaseCheckpoints from './supabase/checkpoints';
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
}
