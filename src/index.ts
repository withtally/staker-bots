import { DatabaseWrapper } from './database';

async function main() {
  console.warn('Starting staker bot...');

  const db = new DatabaseWrapper();

  await db.createDeposit({
    deposit_id: '123',
    owner_address: '0x...',
    delegatee_address: '0x...'
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
