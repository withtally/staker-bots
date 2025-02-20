import fs from 'fs/promises';
import path from 'path';
import { IDatabase } from '../interfaces/IDatabase';
import { Deposit, ProcessingCheckpoint, ScoreEvent } from '../interfaces/types';
import { ConsoleLogger, Logger } from '@/monitor/logging';

export class JsonDatabase implements IDatabase {
  private dbPath: string;
  private logger: Logger;
  public data: {
    deposits: Record<string, Deposit>;
    checkpoints: Record<string, ProcessingCheckpoint>;
    score_events: Record<string, Record<number, ScoreEvent>>;
  };

  constructor(dbPath = 'staker-monitor-db.json') {
    this.dbPath = path.resolve(process.cwd(), dbPath);
    this.logger = new ConsoleLogger('info');
    this.data = {
      deposits: {},
      checkpoints: {},
      score_events: {},
    };
    this.logger.info('JsonDatabase initialized at:', { path: this.dbPath });
    this.initializeDb();
  }

  private async initializeDb() {
    try {
      const fileContent = await fs.readFile(this.dbPath, 'utf-8');
      this.data = JSON.parse(fileContent);
      this.logger.info('Loaded existing database');
    } catch (error) {
      // If file doesn't exist, create it with empty data
      await this.saveToFile();
      this.logger.info('Created new database file');
    }
  }

  private async saveToFile() {
    await fs.writeFile(this.dbPath, JSON.stringify(this.data, null, 2));
    this.logger.debug('Saved database to file');
  }

  // Deposits
  async createDeposit(deposit: Deposit): Promise<void> {
    const now = new Date().toISOString();
    this.data.deposits[deposit.deposit_id] = {
      ...deposit,
      created_at: now,
      updated_at: now,
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
    const deposit = this.data.deposits[depositId];
    if (!deposit) throw new Error(`Deposit ${depositId} not found`);

    // Only update if there are actual changes
    const hasChanges = Object.entries(update).some(
      ([key, value]) => deposit[key as keyof typeof deposit] !== value,
    );

    if (hasChanges) {
      this.data.deposits[depositId] = {
        ...deposit,
        ...update,
        updated_at: new Date().toISOString(),
      };
      await this.saveToFile();
    }
  }

  async getDeposit(depositId: string): Promise<Deposit | null> {
    return this.data.deposits[depositId] || null;
  }

  async getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]> {
    return Object.values(this.data.deposits).filter(
      (deposit) => deposit.delegatee_address === delegateeAddress,
    );
  }

  async getAllDeposits(): Promise<Deposit[]> {
    return Object.values(this.data.deposits);
  }

  // Checkpoints
  async updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    this.data.checkpoints[checkpoint.component_type] = {
      ...checkpoint,
      last_update: new Date().toISOString(),
    };
    await this.saveToFile();
    this.logger.debug('Updated checkpoint:', { checkpoint });
  }

  async getCheckpoint(
    componentType: string,
  ): Promise<ProcessingCheckpoint | null> {
    this.logger.debug('Fetching checkpoint for component:', { componentType });
    const checkpoint = this.data.checkpoints[componentType] || null;
    this.logger.debug('Retrieved checkpoint:', { checkpoint });
    return checkpoint;
  }

  // Score Events
  async createScoreEvent(event: ScoreEvent): Promise<void> {
    if (!this.data.score_events[event.delegatee]) {
      this.data.score_events[event.delegatee] = {};
    }
    const delegateeEvents = this.data.score_events[event.delegatee]!; // Now safe to use !

    const now = new Date().toISOString();
    delegateeEvents[event.block_number] = {
      ...event,
      created_at: now,
      updated_at: now,
    };
    await this.saveToFile();
  }

  async updateScoreEvent(
    delegatee: string,
    blockNumber: number,
    update: Partial<ScoreEvent>,
  ): Promise<void> {
    const delegateeEvents = this.data.score_events[delegatee];
    const event = delegateeEvents?.[blockNumber];
    if (!event || !delegateeEvents) {
      throw new Error(
        `Score event not found for delegatee ${delegatee} at block ${blockNumber}`,
      );
    }

    delegateeEvents[blockNumber] = {
      ...event,
      ...update,
      updated_at: new Date().toISOString(),
    };
    await this.saveToFile();
  }

  async deleteScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<void> {
    const delegateeEvents = this.data.score_events[delegatee];
    if (!delegateeEvents?.[blockNumber]) {
      throw new Error(
        `Score event not found for delegatee ${delegatee} at block ${blockNumber}`,
      );
    }

    delete delegateeEvents[blockNumber];
    if (Object.keys(delegateeEvents).length === 0) {
      delete this.data.score_events[delegatee];
    }
    await this.saveToFile();
  }

  async getScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<ScoreEvent | null> {
    return this.data.score_events[delegatee]?.[blockNumber] || null;
  }

  async getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null> {
    const events = this.data.score_events[delegatee];
    if (!events) return null;

    const blockNumbers = Object.keys(events).map(Number);
    if (blockNumbers.length === 0) return null;

    const latestBlock = Math.max(...blockNumbers);
    return events[latestBlock] || null;
  }

  async getScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]> {
    const events: ScoreEvent[] = [];

    Object.values(this.data.score_events).forEach((delegateeEvents) => {
      Object.entries(delegateeEvents).forEach(([blockStr, event]) => {
        const blockNumber = Number(blockStr);
        if (blockNumber >= fromBlock && blockNumber <= toBlock) {
          events.push(event);
        }
      });
    });

    return events.sort((a, b) => a.block_number - b.block_number);
  }

  async deleteScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    Object.entries(this.data.score_events).forEach(([delegatee, events]) => {
      Object.keys(events).forEach((blockStr) => {
        const blockNumber = Number(blockStr);
        if (blockNumber >= fromBlock && blockNumber <= toBlock) {
          delete events[blockNumber];
        }
      });
      // Clean up empty delegatee entries
      if (Object.keys(events).length === 0) {
        delete this.data.score_events[delegatee];
      }
    });
    await this.saveToFile();
  }
}
