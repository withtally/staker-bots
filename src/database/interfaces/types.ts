export interface Deposit {
  deposit_id: string;
  owner_address: string;
  amount: string;
  delegatee_address: string | null;
  created_at?: string;
  updated_at?: string;
}

export type ScoreEvent = {
  delegatee: string;
  score: string; // Using string for NUMERIC DB type
  block_number: number;
  created_at?: string;
  updated_at?: string;
};

export type ProcessingCheckpoint = {
  component_type: string;
  last_block_number: number;
  block_hash: string;
  last_update: string;
};
