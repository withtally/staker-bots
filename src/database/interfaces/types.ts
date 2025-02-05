export interface Deposit {
  deposit_id: string;
  owner_address: string;
  delegatee_address: string;
}

export interface ProcessingCheckpoint {
  component_type: string;
  last_block_number: number;
  block_hash: string;
  last_update: Date;
}
