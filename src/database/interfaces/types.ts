export interface Deposit {
  deposit_id: string;
  owner_address: string;
  amount: number;
  delegatee_address: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProcessingCheckpoint {
  component_type: string;
  last_block_number: number;
  block_hash: string;
  last_update: string;
}
