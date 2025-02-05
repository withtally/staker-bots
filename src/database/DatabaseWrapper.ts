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

  async getCheckpoint(componentType: string): Promise<ProcessingCheckpoint | null> {
    return this.db.getCheckpoint(componentType);
  }
}
