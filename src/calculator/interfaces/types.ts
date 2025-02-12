import { BigNumber } from 'ethers';

export type ScoreEvent = {
  delegatee: string;
  score: BigNumber;
  block_number: number;
  created_at?: string;
  updated_at?: string;
};

export type CalculatorConfig = {
  type: 'base' | string; // Extensible for future calculator types
};
