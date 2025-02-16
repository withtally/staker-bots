import { Deposit, ProcessingCheckpoint, ScoreEvent } from './types';

export interface IDatabase {
  // Deposits
  createDeposit(deposit: Deposit): Promise<void>;
  getDeposit(depositId: string): Promise<Deposit | null>;
  getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]>;
  updateDeposit(
    depositId: string,
    update: Partial<Omit<Deposit, 'deposit_id'>>,
  ): Promise<void>;
  deleteDeposit(depositId: string): Promise<void>;
  // Checkpoints
  updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void>;
  getCheckpoint(componentType: string): Promise<ProcessingCheckpoint | null>;
  // Score Events
  createScoreEvent(event: ScoreEvent): Promise<void>;
  updateScoreEvent(
    delegatee: string,
    blockNumber: number,
    update: Partial<ScoreEvent>,
  ): Promise<void>;
  deleteScoreEvent(delegatee: string, blockNumber: number): Promise<void>;
  deleteScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void>;
  getScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<ScoreEvent | null>;
  getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null>;
  getScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]>;
}
