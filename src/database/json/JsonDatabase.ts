import fs from 'fs/promises';
import path from 'path';
import { IDatabase } from '../interfaces/IDatabase';
import { Deposit, ProcessingCheckpoint } from '../interfaces/types';

export class JsonDatabase implements IDatabase {
  private dbPath: string;
  private data: {
    deposits: Record<string, Deposit>;
    checkpoints: Record<string, ProcessingCheckpoint>;
  };

  constructor(dbPath = '.local-db.json') {
    this.dbPath = path.resolve(process.cwd(), dbPath);
    this.data = {
      deposits: {},
      checkpoints: {},
    };
    this.initializeDb();
  }

  private async initializeDb() {
    try {
      const fileContent = await fs.readFile(this.dbPath, 'utf-8');
      this.data = JSON.parse(fileContent);
    } catch (error) {
      // If file doesn't exist, create it with empty data
      await this.saveToFile();
    }
  }

  private async saveToFile() {
    await fs.writeFile(this.dbPath, JSON.stringify(this.data, null, 2));
  }

  // Deposits
  async createDeposit(deposit: Deposit): Promise<void> {
    this.data.deposits[deposit.deposit_id] = {
      ...deposit,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.saveToFile();
  }

  async getDeposit(depositId: string): Promise<Deposit | null> {
    return this.data.deposits[depositId] || null;
  }

  async getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]> {
    return Object.values(this.data.deposits).filter(
      (deposit) => deposit.delegatee_address === delegateeAddress
    );
  }

  // Checkpoints
  async updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    this.data.checkpoints[checkpoint.component_type] = {
      ...checkpoint,
      last_update: new Date().toISOString(),
    };
    await this.saveToFile();
  }

  async getCheckpoint(componentType: string): Promise<ProcessingCheckpoint | null> {
    return this.data.checkpoints[componentType] || null;
  }
}
