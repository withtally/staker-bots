import { Deposit, ProcessingCheckpoint } from './types';

export interface IDatabase {
  // Deposits
  createDeposit(deposit: Deposit): Promise<void>;
  getDeposit(depositId: string): Promise<Deposit | null>;
  getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]>;

  // Checkpoints
  updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void>;
  getCheckpoint(componentType: string): Promise<ProcessingCheckpoint | null>;
}
