import { StakerMonitor } from './StakerMonitor';
import { DatabaseWrapper } from '@/database';
import { CONFIG, createProvider } from '@/config';
import { createMonitorConfig } from './constants';

async function main() {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    console.error('Failed to connect to provider:', error);
    process.exit(1);
  }

  // Initialize database
  const database = new DatabaseWrapper({
    type: CONFIG.monitor.databaseType
  });

  const monitor = new StakerMonitor(createMonitorConfig(provider, database));

  // Handle shutdown gracefully
  async function shutdown(signal: string) {
    console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
    try {
      await monitor.stop();
      console.log('Shutdown completed successfully');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start monitor
  try {
    await monitor.start();

    // Health check logging
    setInterval(async () => {
      try {
        const status = await monitor.getMonitorStatus();
        console.log('Monitor Status:', {
          isRunning: status.isRunning,
          processingLag: status.processingLag,
          currentBlock: status.currentChainBlock,
          lastProcessedBlock: status.lastProcessedBlock
        });
      } catch (error) {
        console.error('Health check failed:', error);
      }
    }, CONFIG.monitor.healthCheckInterval * 1000);

  } catch (error) {
    console.error('Failed to start monitor:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Run the monitor
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
