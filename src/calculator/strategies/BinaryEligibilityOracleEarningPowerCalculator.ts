import { ICalculatorStrategy } from '../interfaces/ICalculatorStrategy';
import { ScoreEvent } from '../interfaces/types';
import { DatabaseWrapper } from '@/database/DatabaseWrapper';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { ethers } from 'ethers';
import { CONFIG, createProvider } from '@/config';
import { REWARD_CALCULATOR_ABI } from '../constants';
// import { ScoreEvent as DbScoreEvent } from '@/database/interfaces/types';

export class BinaryEligibilityOracleEarningPowerCalculator
  implements ICalculatorStrategy
{
  private db: DatabaseWrapper;
  private logger: Logger;
  private scoreCache: Map<string, bigint>;
  private readonly contract: ethers.Contract;

  constructor(db: DatabaseWrapper) {
    this.db = db;
    this.logger = new ConsoleLogger('info');
    this.scoreCache = new Map();

    // Initialize contract
    const provider = createProvider();
    if (!CONFIG.monitor.rewardCalculatorAddress) {
      throw new Error('REWARD_CALCULATOR_ADDRESS is not configured');
    }
    this.contract = new ethers.Contract(
      CONFIG.monitor.rewardCalculatorAddress,
      REWARD_CALCULATOR_ABI,
      provider,
    );
  }

  async getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
  ): Promise<bigint> {
    try {
      const earningPower = await (this.contract as any).getEarningPower(
        amountStaked,
        staker,
        delegatee,
      );
      return BigInt(earningPower.toString());
    } catch (error) {
      this.logger.error('Error getting earning power from contract:', {
        error,
      });
      throw error;
    }
  }

  async getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint,
  ): Promise<[bigint, boolean]> {
    try {
      const [newEarningPower, isBumpable] = await (
        this.contract as any
      ).getNewEarningPower(amountStaked, staker, delegatee, oldEarningPower);
      return [BigInt(newEarningPower.toString()), isBumpable];
    } catch (error) {
      this.logger.error('Error getting new earning power from contract:', {
        error,
      });
      throw error;
    }
  }

  async processScoreEvents(fromBlock: number, toBlock: number): Promise<void> {
    try {
      // Get events from blockchain
      const events = await this.contract.queryFilter(
        (this.contract as any).filters.ScoreUpdated(),
        fromBlock,
        toBlock,
      );

      // Process events in batch
      for (const event of events) {
        const typedEvent = event as ethers.EventLog;
        const { delegatee, score, blockNumber } = typedEvent.args;
        await this.processScoreEvent({
          delegatee,
          score: BigInt(score.toString()),
          block_number: blockNumber,
        });
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
