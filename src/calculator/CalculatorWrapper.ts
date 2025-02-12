import { ICalculatorStrategy } from './interfaces/ICalculatorStrategy';
import { BaseCalculatorStrategy } from './strategies/BaseCalculatorStrategy';
import { CalculatorConfig } from './interfaces/types';
import { DatabaseWrapper } from '@/database/DatabaseWrapper';

export class CalculatorWrapper implements ICalculatorStrategy {
  private strategy: ICalculatorStrategy;

  constructor(
    db: DatabaseWrapper,
    config: CalculatorConfig = { type: 'base' }
  ) {
    // Initialize with base strategy by default
    this.strategy = new BaseCalculatorStrategy(db);

    // Can extend here to support other calculator types
    if (config.type !== 'base') {
      throw new Error(`Calculator type ${config.type} not supported`);
    }
  }

  async getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string
  ): Promise<bigint> {
    return this.strategy.getEarningPower(amountStaked, staker, delegatee);
  }

  async getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint
  ): Promise<[bigint, boolean]> {
    return this.strategy.getNewEarningPower(
      amountStaked,
      staker,
      delegatee,
      oldEarningPower
    );
  }

  async processScoreEvents(fromBlock: number, toBlock: number): Promise<void> {
    return this.strategy.processScoreEvents(fromBlock, toBlock);
  }
}
