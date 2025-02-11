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

  constructor(dbPath = 'staker-monitor-db.json') {
    this.dbPath = path.resolve(process.cwd(), dbPath);
    this.data = {
      deposits: {},
      checkpoints: {},
    };
    console.log('JsonDatabase initialized at:', this.dbPath);
    this.initializeDb();
  }

  private async initializeDb() {
    try {
      const fileContent = await fs.readFile(this.dbPath, 'utf-8');
      this.data = JSON.parse(fileContent);
      console.log('Loaded existing database');
    } catch (error) {
      // If file doesn't exist, create it with empty data
      await this.saveToFile();
      console.log('Created new database file');
    }
  }

  private async saveToFile() {
    await fs.writeFile(this.dbPath, JSON.stringify(this.data, null, 2));
    console.log('Saved database to file');
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

  async deleteDeposit(depositId: string): Promise<void> {
    if (!this.data.deposits[depositId]) {
      throw new Error(`Deposit ${depositId} not found`);
    }

    delete this.data.deposits[depositId];
    await this.saveToFile();
  }

  async updateDeposit(
    depositId: string,
    update: Partial<Omit<Deposit, 'deposit_id'>>,
  ): Promise<void> {
    let deposit = this.data.deposits[depositId];
    if (!deposit) throw new Error(`Deposit ${depositId} not found`);

    deposit = {
      ...deposit,
      ...update,
      updated_at: new Date().toISOString(),
    };
    this.data.deposits[depositId] = deposit;

    await this.saveToFile();
  }

  async getDeposit(depositId: string): Promise<Deposit | null> {
    return this.data.deposits[depositId] || null;
  }

  async getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]> {
    return Object.values(this.data.deposits).filter(
      (deposit) => deposit.delegatee_address === delegateeAddress,
    );
  }

  // Checkpoints
  async updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    this.data.checkpoints[checkpoint.component_type] = {
      ...checkpoint,
      last_update: new Date().toISOString(),
    };
    await this.saveToFile();
    console.log('Updated checkpoint:', checkpoint);
  }

  async getCheckpoint(componentType: string): Promise<ProcessingCheckpoint | null> {
    console.log('Fetching checkpoint for component:', componentType);
    console.log('Current checkpoints in DB:', this.data.checkpoints);
    const checkpoint = this.data.checkpoints[componentType] || null;
    console.log('Retrieved checkpoint result:', checkpoint);
    return checkpoint;
  }
}
