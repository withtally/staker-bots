import { DatabaseWrapper } from '@/database';
import { CONFIG, createProvider } from '@/config';
import { CalculatorWrapper } from './CalculatorWrapper';
import { ConsoleLogger } from '@/monitor/logging';

async function main() {
  const logger = new ConsoleLogger('info');

  try {
    // Initialize database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType,
    });

    // Initialize provider
    const provider = createProvider();

    // Initialize calculator
    const calculator = new CalculatorWrapper(database, provider);

    // Test specific block
    const testBlock = 305355155;
    logger.info('Testing specific block for events...', { blockNumber: testBlock });

    await calculator.processScoreEvents(testBlock, testBlock);

    // Get all events from database for this block
    const events = await database.getScoreEventsByBlockRange(testBlock, testBlock);
    logger.info('Events found in database:', {
      blockNumber: testBlock,
      eventCount: events.length,
      events: events.map(e => ({
        delegatee: e.delegatee,
        score: e.score,
        block_number: e.block_number
      }))
    });

  } catch (error) {
    logger.error('Error running calculator:', { error });
    process.exit(1);
  }
}

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down...');
  process.exit(0);
});

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
