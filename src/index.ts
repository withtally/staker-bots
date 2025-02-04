import { config } from 'dotenv';

// Load environment variables
config();

async function main() {
  console.warn('Starting staker bot...');
  // Your main logic here
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
