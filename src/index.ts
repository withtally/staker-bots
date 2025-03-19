import { DatabaseWrapper } from './database';
import { CONFIG } from './config';
import { ConsoleLogger } from './monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { CalculatorWrapper } from './calculator/CalculatorWrapper';
import { ExecutorWrapper, ExecutorType } from './executor';
import { ProfitabilityEngineWrapper } from './profitability/ProfitabilityEngineWrapper';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';
import type { Deposit as DBDeposit } from './database/interfaces/types';
import type { Deposit as ProfitabilityDeposit } from './profitability/interfaces/types';

// Create component-specific loggers with colors
const monitorLogger = new ConsoleLogger('info', {
  color: '\x1b[34m', // Blue
  prefix: '[Monitor]',
});
const calculatorLogger = new ConsoleLogger('info', {
  color: '\x1b[35m', // Purple
  prefix: '[Calculator]',
});
const profitabilityLogger = new ConsoleLogger('info', {
  color: '\x1b[31m', // Red
  prefix: '[Profitability]',
});
const executorLogger = new ConsoleLogger('info', {
  color: '\x1b[31m', // Red
  prefix: '[Executor]',
});
const logger = new ConsoleLogger('info');

const ERROR_LOG_PATH = path.join(process.cwd(), 'error.logs');

// Load full staker ABI from tests
const STAKER_ABI = JSON.parse(
  await fs.readFile('./src/tests/abis/staker.json', 'utf8'),
);

// Create provider helper function
function createProvider() {
  return new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
}

// Convert database deposit to profitability deposit
function convertDeposit(deposit: DBDeposit): ProfitabilityDeposit {
  return {
    deposit_id: BigInt(deposit.deposit_id),
    owner_address: deposit.owner_address,
    delegatee_address: deposit.delegatee_address,
    amount: BigInt(deposit.amount),
    created_at: deposit.created_at,
    updated_at: deposit.updated_at,
  };
}

async function logError(error: unknown, context: string) {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ${context}: ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ''}\n\n`;
  await fs.appendFile(ERROR_LOG_PATH, errorMessage);
  logger.error(context, { error });
}

async function waitForDeposits(database: DatabaseWrapper): Promise<boolean> {
  try {
    const deposits = await database.getAllDeposits();
    return deposits.length > 0;
  } catch (error) {
    await logError(error, 'Error checking deposits');
    return false;
  }
}

const runningComponents: {
  monitor?: StakerMonitor;
  calculator?: CalculatorWrapper;
  profitabilityEngine?: ProfitabilityEngineWrapper;
  transactionExecutor?: ExecutorWrapper;
} = {};

async function shutdown(signal: string) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  try {
    if (runningComponents.monitor) {
      await runningComponents.monitor.stop();
    }
    if (runningComponents.calculator) {
      await runningComponents.calculator.stop();
    }
    if (runningComponents.profitabilityEngine) {
      await runningComponents.profitabilityEngine.stop();
    }
    if (runningComponents.transactionExecutor) {
      await runningComponents.transactionExecutor.stop();
    }
    logger.info('Shutdown completed successfully');
    process.exit(0);
  } catch (error) {
    await logError(error, 'Error during shutdown');
    process.exit(1);
  }
}

async function runMonitor(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    monitorLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  const monitor = new StakerMonitor(createMonitorConfig(provider, database));

  // Start monitor
  await monitor.start();

  // Health check logging
  setInterval(async () => {
    try {
      const status = await monitor.getMonitorStatus();
      monitorLogger.info('Monitor Status:', {
        isRunning: status.isRunning,
        processingLag: status.processingLag,
        currentBlock: status.currentChainBlock,
        lastProcessedBlock: status.lastProcessedBlock,
      });
    } catch (error) {
      monitorLogger.error('Health check failed:', { error });
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
    calculatorLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  calculatorLogger.info(
    'Initializing calculator with reward calculator contract:',
    {
      address: CONFIG.monitor.rewardCalculatorAddress,
    },
  );

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
    calculatorLogger.info('Processing initial score events...', {
      fromBlock: initialFromBlock,
      toBlock: initialToBlock,
      rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
    });

    await calculator.processScoreEvents(initialFromBlock, initialToBlock);
    calculatorLogger.info('Initial score events processed successfully');
  }

  // Set up periodic score event processing
  const processInterval = setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        calculatorLogger.info('Calculator stopped, clearing interval');
        clearInterval(processInterval);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      if (!lastCheckpoint) {
        calculatorLogger.error('No checkpoint found for calculator');
        return;
      }

      const fromBlock = lastCheckpoint.last_block_number + 1;
      const toBlock = Math.min(
        currentBlock - CONFIG.monitor.confirmations,
        fromBlock + CONFIG.monitor.maxBlockRange,
      );

      if (toBlock > fromBlock) {
        calculatorLogger.info('Processing new score events...', {
          fromBlock,
          toBlock,
          rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
          lastProcessedBlock: lastCheckpoint.last_block_number,
        });
        await calculator.processScoreEvents(fromBlock, toBlock);

        // Update checkpoint
        const block = await provider.getBlock(toBlock);
        if (!block) throw new Error(`Block ${toBlock} not found`);

        await database.updateCheckpoint({
          component_type: 'calculator',
          last_block_number: toBlock,
          block_hash: block.hash!,
          last_update: new Date().toISOString(),
        });

        calculatorLogger.info('Score events processed successfully', {
          fromBlock,
          toBlock,
          processedBlocks: toBlock - fromBlock + 1,
        });
      } else {
        calculatorLogger.debug('No new blocks to process', {
          currentBlock,
          lastProcessedBlock: lastCheckpoint.last_block_number,
          confirmations: CONFIG.monitor.confirmations,
        });
      }
    } catch (error) {
      await logError(error, 'Error processing score events');
    }
  }, CONFIG.monitor.pollInterval * 1000);

  // Set up health check logging
  const healthCheckInterval = setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        calculatorLogger.info(
          'Calculator stopped, clearing health check interval',
        );
        clearInterval(healthCheckInterval);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      calculatorLogger.info('Calculator Status:', {
        isRunning: status.isRunning,
        lastProcessedBlock:
          lastCheckpoint?.last_block_number ?? status.lastProcessedBlock,
        currentBlock,
        processingLag:
          currentBlock -
          (lastCheckpoint?.last_block_number ?? status.lastProcessedBlock),
      });
    } catch (error) {
      await logError(error, 'Calculator health check failed');
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return calculator;
}

async function runProfitabilityEngine(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    profitabilityLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  profitabilityLogger.info(
    'Initializing profitability engine with staker contract:',
    {
      address: CONFIG.monitor.stakerAddress,
    },
  );

  if (!CONFIG.profitability?.rewardTokenAddress) {
    throw new Error('Reward token address not configured');
  }

  const engine = new ProfitabilityEngineWrapper(
    database,
    provider,
    CONFIG.monitor.stakerAddress,
    profitabilityLogger,
    {
      minProfitMargin: BigInt(1e13), // 0.00001 ETH
      gasPriceBuffer: 20, // 20%
      maxBatchSize: 10,
      rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
      defaultTipReceiver: CONFIG.executor?.tipReceiver || ethers.ZeroAddress,
      priceFeed: {
        cacheDuration: 10 * 60 * 1000, // 10 minutes
      },
    },
  );
  await engine.start();

  // Set up health check logging
  setInterval(async () => {
    try {
      const status = await engine.getStatus();
      profitabilityLogger.info('Profitability Engine Status:', {
        isRunning: status.isRunning,
        lastGasPrice: status.lastGasPrice.toString(),
        lastUpdateTimestamp: new Date(status.lastUpdateTimestamp).toISOString(),
      });
    } catch (error) {
      await logError(error, 'Profitability engine health check failed');
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return engine;
}

async function runExecutor() {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    executorLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  // Initialize staker contract
  const stakerContract = new ethers.Contract(
    CONFIG.monitor.stakerAddress,
    STAKER_ABI,
    provider,
  );

  executorLogger.info('Initializing executor with staker contract:', {
    address: CONFIG.monitor.stakerAddress,
  });

  if (!CONFIG.executor?.privateKey) {
    throw new Error('Executor private key not configured');
  }

  const executor = new ExecutorWrapper(
    stakerContract,
    provider,
    ExecutorType.WALLET,
    {
      wallet: {
        privateKey: CONFIG.executor.privateKey,
        minBalance: ethers.parseEther('0.0000001'), // very small for testing
        maxPendingTransactions: 5,
      },
      maxQueueSize: 100,
      minConfirmations: CONFIG.monitor.confirmations,
      maxRetries: CONFIG.monitor.maxRetries,
      retryDelayMs: 5000,
      transferOutThreshold: ethers.parseEther('0.001'), // 0.001 ETH
      gasBoostPercentage: 10, // 10%
      concurrentTransactions: 3,
    },
  );

  await executor.start();

  // Set up health check logging
  setInterval(async () => {
    try {
      const status = await executor.getStatus();
      executorLogger.info('Executor Status:', {
        isRunning: status.isRunning,
        walletBalance: ethers.formatEther(status.walletBalance),
        pendingTransactions: status.pendingTransactions,
        queueSize: status.queueSize,
      });
    } catch (error) {
      await logError(error, 'Executor health check failed');
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return executor;
}

async function main() {
  try {
    // Initialize database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType,
    });

    // Start monitor first
    logger.info('Starting monitor...');
    runningComponents.monitor = await runMonitor(database);

    // Wait for initial deposits before starting calculator
    logger.info('Waiting for initial deposits...');
    while (!(await waitForDeposits(database))) {
      await new Promise((resolve) => setTimeout(resolve, 60000)); // Check every minute
    }

    // Start calculator with deposit-dependent scheduling
    logger.info('Starting calculator...');
    runningComponents.calculator = await runCalculator(database);

    // Start profitability engine
    logger.info('Starting profitability engine...');
    runningComponents.profitabilityEngine =
      await runProfitabilityEngine(database);

    // Start executor with profitability verification
    logger.info('Starting transaction executor...');
    runningComponents.transactionExecutor = await runExecutor();

    // Set up profitability check interval (every 1 minute)
    setInterval(
      async () => {
        try {
          const profitabilityEngine = runningComponents.profitabilityEngine;
          const executor = runningComponents.transactionExecutor;
          if (!profitabilityEngine || !executor) return;

          // Only run if there are deposits
          const deposits = await database.getAllDeposits();
          if (deposits.length === 0) {
            profitabilityLogger.debug(
              'No deposits found, skipping profitability check',
            );
            return;
          }

          // Analyze batch profitability
          const batchAnalysis =
            await profitabilityEngine.analyzeBatchProfitability(
              deposits.map(convertDeposit),
            );

          // Process profitable deposits
          for (const result of batchAnalysis.deposits) {
            if (result.profitability.canBump) {
              try {
                // Queue transaction for execution
                await executor.queueTransaction(
                  result.depositId,
                  result.profitability,
                );

                executorLogger.info('Transaction queued for deposit:', {
                  depositId: result.depositId.toString(),
                  expectedProfit: ethers.formatEther(
                    result.profitability.estimates.expectedProfit,
                  ),
                  optimalTip: ethers.formatEther(
                    result.profitability.estimates.optimalTip,
                  ),
                });
              } catch (error) {
                executorLogger.error(
                  `Error queueing transaction for deposit ${result.depositId}`,
                  { error },
                );
              }
            }
          }

          // Log queue stats
          const queueStats = await executor.getQueueStats();
          executorLogger.info('Current queue stats:', {
            totalQueued: queueStats.totalQueued,
            totalPending: queueStats.totalPending,
            totalConfirmed: queueStats.totalConfirmed,
            totalFailed: queueStats.totalFailed,
          });
        } catch (error) {
          profitabilityLogger.error('Error in profitability check interval', {
            error,
          });
        }
      },
      60 * 1000, // 1 minute
    );

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    await logError(error, 'Fatal error in main');
    // Don't exit - let the process continue
    logger.info('Recovering from error and continuing...');
  }
}

// Handle uncaught errors without exiting
process.on('uncaughtException', async (error) => {
  await logError(error, 'Uncaught exception');
  // Don't exit - let the process continue
});

process.on('unhandledRejection', async (reason) => {
  await logError(reason, 'Unhandled rejection');
  // Don't exit - let the process continue
});

// Run the application
main().catch(async (error) => {
  await logError(error, 'Fatal error in main');
  // Don't exit - let the process continue
  logger.info('Recovering from error and continuing...');
});
