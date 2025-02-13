import { DatabaseWrapper } from '@/database';
import { CONFIG, createProvider } from '@/config';
import { ConsoleLogger } from '@/monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { CalculatorWrapper } from './calculator/CalculatorWrapper';

const logger = new ConsoleLogger('info');

async function runMonitor(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    logger.error('Failed to connect to provider:', { error });
    throw error;
  }

  const monitor = new StakerMonitor(createMonitorConfig(provider, database));

  // Start monitor
  await monitor.start();

  // Health check logging
  setInterval(async () => {
    try {
      const status = await monitor.getMonitorStatus();
      logger.info('Monitor Status:', {
        isRunning: status.isRunning,
        processingLag: status.processingLag,
        currentBlock: status.currentChainBlock,
        lastProcessedBlock: status.lastProcessedBlock,
      });
    } catch (error) {
      logger.error('Health check failed:', { error });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return monitor;
}

async function runCalculator(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    logger.error('Failed to connect to provider:', { error });
    throw error;
  }

  logger.info('Initializing calculator with reward calculator contract:', {
    address: CONFIG.monitor.rewardCalculatorAddress,
  });

  const calculator = new CalculatorWrapper(database, provider);
  await calculator.start();

  // Get initial block range
  const currentBlock = await provider.getBlockNumber();
  const lastCheckpoint = await database.getCheckpoint('calculator');
  const initialFromBlock = lastCheckpoint?.last_block_number
    ? lastCheckpoint.last_block_number + 1
    : CONFIG.monitor.startBlock;
  const initialToBlock = Math.min(
    currentBlock - CONFIG.monitor.confirmations,
    initialFromBlock + CONFIG.monitor.maxBlockRange,
  );

  if (initialToBlock > initialFromBlock) {
    logger.info('Processing initial score events...', {
      fromBlock: initialFromBlock,
      toBlock: initialToBlock,
      rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
    });

    await calculator.processScoreEvents(initialFromBlock, initialToBlock);
    logger.info('Initial score events processed successfully');
  }

  // Set up periodic score event processing
  const processInterval = setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        logger.info('Calculator stopped, clearing interval');
        clearInterval(processInterval);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      if (!lastCheckpoint) {
        logger.error('No checkpoint found for calculator');
        return;
      }

      const fromBlock = lastCheckpoint.last_block_number + 1;
      const toBlock = Math.min(
        currentBlock - CONFIG.monitor.confirmations,
        fromBlock + CONFIG.monitor.maxBlockRange,
      );

      if (toBlock > fromBlock) {
        logger.info('Processing new score events...', {
          fromBlock,
          toBlock,
          rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
          lastProcessedBlock: lastCheckpoint.last_block_number,
        });
        await calculator.processScoreEvents(fromBlock, toBlock);
        logger.info('Score events processed successfully', {
          fromBlock,
          toBlock,
          processedBlocks: toBlock - fromBlock + 1,
        });
      } else {
        logger.debug('No new blocks to process', {
          currentBlock,
          lastProcessedBlock: lastCheckpoint.last_block_number,
          confirmations: CONFIG.monitor.confirmations,
        });
      }
    } catch (error) {
      logger.error('Error processing score events:', { error });
    }
  }, CONFIG.monitor.pollInterval * 1000);

  // Set up health check logging
  const healthCheckInterval = setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        logger.info('Calculator stopped, clearing health check interval');
        clearInterval(healthCheckInterval);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      logger.info('Calculator Status:', {
        isRunning: status.isRunning,
        lastProcessedBlock:
          lastCheckpoint?.last_block_number ?? status.lastProcessedBlock,
        currentBlock,
        processingLag:
          currentBlock -
          (lastCheckpoint?.last_block_number ?? status.lastProcessedBlock),
      });
    } catch (error) {
      logger.error('Calculator health check failed:', { error });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return calculator;
}

async function main() {
  try {
    // Initialize database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType,
    });

    const components = (process.env.COMPONENTS || '')
      .split(',')
      .map((c) => c.trim());
    const runningComponents: {
      monitor?: StakerMonitor;
      calculator?: CalculatorWrapper;
    } = {};

    // Start components based on configuration
    if (components.includes('monitor')) {
      logger.info('Starting monitor...');
      runningComponents.monitor = await runMonitor(database);
    }

    if (components.includes('calculator')) {
      logger.info('Starting calculator...');
      runningComponents.calculator = await runCalculator(database);
    }

    if (Object.keys(runningComponents).length === 0) {
      throw new Error(
        'No components configured to run. Set COMPONENTS env var.',
      );
    }

    // Handle shutdown gracefully
    async function shutdown(signal: string) {
      logger.info(`Received ${signal}. Starting graceful shutdown...`);
      try {
        if (runningComponents.monitor) {
          await runningComponents.monitor.stop();
        }
        if (runningComponents.calculator) {
          await runningComponents.calculator.stop();
        }
        logger.info('Shutdown completed successfully');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', { error });
        process.exit(1);
      }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Fatal error:', { error });
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', { error });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', { reason });
  process.exit(1);
});

// Run the application
main().catch((error) => {
  logger.error('Fatal error:', { error });
  process.exit(1);
});
