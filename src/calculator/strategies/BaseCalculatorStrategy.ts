import { ICalculatorStrategy } from '../interfaces/ICalculatorStrategy';
import { ScoreEvent } from '../interfaces/types';
import { DatabaseWrapper } from '@/database/DatabaseWrapper';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { ScoreEvent as DbScoreEvent } from '@/database/interfaces/types';

export class BaseCalculatorStrategy implements ICalculatorStrategy {
  private db: DatabaseWrapper;
  private logger: Logger;
  private scoreCache: Map<string, bigint>;

  constructor(db: DatabaseWrapper) {
    this.db = db;
    this.logger = new ConsoleLogger('info');
    this.scoreCache = new Map();
  }

  async getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
  ): Promise<bigint> {
    const score = await this.getDelegateeScore(delegatee);
    return amountStaked * score;
  }

  async getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint,
  ): Promise<[bigint, boolean]> {
    const newEarningPower = await this.getEarningPower(
      amountStaked,
      staker,
      delegatee,
    );
    const isBumpable = newEarningPower > oldEarningPower;

    return [newEarningPower, isBumpable];
  }

  async processScoreEvents(fromBlock: number, toBlock: number): Promise<void> {
    try {
      // Get events from blockchain (implementation depends on your provider setup)
      const events = await this.getScoreEvents(fromBlock, toBlock);

      // Process events in batch
      for (const event of events) {
        await this.processScoreEvent(event);
      }

      // Update processing checkpoint
      await this.db.updateCheckpoint({
        component_type: 'calculator',
        last_block_number: toBlock,
        block_hash:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        last_update: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error processing score events:', { error });
      throw error;
    }
  }

  private async processScoreEvent(event: ScoreEvent): Promise<void> {
    this.scoreCache.set(event.delegatee, event.score);
    await this.db.createScoreEvent({
      ...event,
      score: event.score.toString(), // Convert bigint to string for database
    });
  }

  private async getDelegateeScore(delegatee: string): Promise<bigint> {
    const cachedScore = this.scoreCache.get(delegatee);
    if (cachedScore) return cachedScore;

    const latestEvent = await this.getLatestScoreEvent(delegatee);
    if (!latestEvent?.score) return BigInt(0);

    const score = BigInt(latestEvent.score);
    this.scoreCache.set(delegatee, score);
    return score;
  }

  private async getLatestScoreEvent(
    delegatee: string,
  ): Promise<ScoreEvent | null> {
    const dbEvent = await this.db.getLatestScoreEvent(delegatee);
    return dbEvent ? { ...dbEvent, score: BigInt(dbEvent.score) } : null;
  }

  private async getScoreEvents(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]> {
    const dbEvents = await this.db.getScoreEventsByBlockRange(
      fromBlock,
      toBlock,
    );
    return dbEvents.map((e) => ({ ...e, score: BigInt(e.score) }));
  }
}
