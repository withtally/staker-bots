import { ethers } from 'ethers';
import { ScoreSimulator, SimulatorOptions } from './test-score';
import { DatabaseWrapper } from '../database';
import { ConsoleLogger } from '../monitor/logging';
import { CONFIG } from '../config';
import { CalculatorWrapper } from '../calculator/CalculatorWrapper';
import { ProfitabilityEngineWrapper } from '../profitability';
import { ExecutorWrapper, ExecutorType } from '../executor';
import { STAKER_ABI } from '../monitor/constants';
import { config } from 'dotenv';

// Load .env.test file
config({ path: '.env.test' });

const logger = new ConsoleLogger('info');

// Test configuration
interface TestHarnessConfig {
  // Network and contract settings
  rpcUrl: string;
  stakerAddress: string;
  calculatorAddress: string;
  oraclePrivateKey: string;
  // Test parameters
  randomDelegatees: number;
  specificDelegatees: Array<{address: string, score: number}>;
  thresholdScore: number;
  // Test flow settings
  calculatorPollInterval: number;
  testDuration: number;
  // Monitoring settings
  loggingInterval: number;
  databasePath: string;
}

class TestHarness {
  private provider: ethers.Provider;
  private scoreSimulator: ScoreSimulator;
  private database: DatabaseWrapper;
  private calculator: CalculatorWrapper;
  private profitability: ProfitabilityEngineWrapper;
  private executor?: ExecutorWrapper;
  private config: TestHarnessConfig;
  private isRunning: boolean = false;
  private monitorInterval?: NodeJS.Timeout;

  constructor(config: TestHarnessConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    // Initialize simulator
    const simulatorOptions: SimulatorOptions = {
      privateKey: config.oraclePrivateKey,
      rpcUrl: config.rpcUrl,
      calculatorAddress: config.calculatorAddress,
      mode: 'controlled'
    };
    this.scoreSimulator = new ScoreSimulator(simulatorOptions);

    // Initialize database
    this.database = new DatabaseWrapper({
      type: 'json',
      jsonDbPath: config.databasePath
    });

    // Initialize calculator
    this.calculator = new CalculatorWrapper(this.database, this.provider);

    // Initialize profitability engine
    this.profitability = new ProfitabilityEngineWrapper(
      this.database,
      this.provider,
      config.stakerAddress,
      {
        minProfitMargin: ethers.parseEther('0.001'), // 0.001 ETH
        gasPriceBuffer: 20, // 20% buffer
        maxBatchSize: 10,
        defaultTipReceiver: ethers.ZeroAddress,
        priceFeed: {
          cacheDuration: 60000 // 1 minute
        }
      }
    );
  }

  async init() {
    // Initialize components
    await this.calculator.start();
    await this.profitability.start();

    // Initialize executor if private key is provided
    if (process.env.EXECUTOR_PRIVATE_KEY) {
      const stakerContract = new ethers.Contract(
        this.config.stakerAddress,
        STAKER_ABI,
        this.provider
      );

      this.executor = new ExecutorWrapper(stakerContract, this.provider,
        ExecutorType.WALLET,
        {
          wallet: {
            privateKey: process.env.EXECUTOR_PRIVATE_KEY,
            minBalance: ethers.parseEther('0.05'), // 0.05 ETH
            maxPendingTransactions: 3
          },
          gasBoostPercentage: 5, // 5% gas boost
          concurrentTransactions: 2,
          maxRetries: 2,
          retryDelayMs: 2000
        });

      await this.executor.start();
      logger.info('Executor initialized and started');
    } else {
      logger.warn('No executor private key provided, transaction execution disabled');
    }

    logger.info('Test harness initialized successfully');
  }

  async setupInitialState() {
    logger.info('Setting up initial test state...');

    // First, generate and update random delegatees
    for (let i = 0; i < this.config.randomDelegatees; i++) {
      const delegatee = ethers.Wallet.createRandom().address;
      const isAboveThreshold = Math.random() > 0.5;

      let score;
      if (isAboveThreshold) {
        score = this.config.thresholdScore + Math.floor(Math.random() * 20) + 1;
      } else {
        score = Math.max(0, this.config.thresholdScore - Math.floor(Math.random() * 20) - 1);
      }

      await this.scoreSimulator.updateScore(delegatee, score);

      // Create a test deposit in the database
      await this.database.createDeposit({
        deposit_id: i.toString(),
        owner_address: ethers.Wallet.createRandom().address,
        delegatee_address: delegatee,
        amount: ethers.parseEther((10 + Math.random() * 90).toString()).toString()
      });

      logger.info(`Created test deposit ${i} with delegatee ${delegatee} and score ${score}`);
    }

    // Then update specific delegatees if any
    for (const {address, score} of this.config.specificDelegatees) {
      await this.scoreSimulator.updateScore(address, score);
    }

    logger.info('Initial state setup completed');
  }

  async runTest() {
    if (this.isRunning) {
      logger.warn('Test is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting test harness...');

    // Initialize components
    await this.init();

    // Setup initial state
    await this.setupInitialState();

    // Start monitoring
    this.startMonitoring();

    // Run the main test flow
    await this.runTestFlow();

    // Wait for the specified test duration
    logger.info(`Test will run for ${this.config.testDuration}ms`);
    await new Promise(resolve => setTimeout(resolve, this.config.testDuration));

    // Stop test
    await this.stop();
  }

  private startMonitoring() {
    this.monitorInterval = setInterval(async () => {
      try {
        // Get status of components
        const [calculatorStatus, profitabilityStatus] = await Promise.all([
          this.calculator.getStatus(),
          this.profitability.getStatus()
        ]);

        // Get executor status if available
        let executorStatus = null;
        if (this.executor) {
          executorStatus = await this.executor.getStatus();
        }

        // Log status information
        logger.info('Test Harness Status:', {
          calculator: {
            isRunning: calculatorStatus.isRunning,
            lastProcessedBlock: calculatorStatus.lastProcessedBlock
          },
          profitability: {
            isRunning: profitabilityStatus.isRunning,
            lastGasPrice: profitabilityStatus.lastGasPrice.toString(),
            lastUpdateTimestamp: new Date(profitabilityStatus.lastUpdateTimestamp).toISOString()
          },
          executor: executorStatus ? {
            isRunning: executorStatus.isRunning,
            walletBalance: ethers.formatEther(executorStatus.walletBalance),
            pendingTransactions: executorStatus.pendingTransactions,
            queueSize: executorStatus.queueSize
          } : 'Not configured'
        });

        // Get deposits and their profitability
        const deposits = await this.database.getAllDeposits();

        // Skip if no deposits
        if (!deposits.length) {
          logger.warn('No deposits found in database');
          return;
        }

        // Format for profitability analysis
        const profitabilityDeposits = deposits.map(d => ({
          deposit_id: BigInt(d.deposit_id),
          owner_address: d.owner_address,
          delegatee_address: d.delegatee_address,
          amount: BigInt(d.amount),
        }));

        // Analyze profitability
        const analysis = await this.profitability.analyzeBatchProfitability(profitabilityDeposits);

        // Log deposits that can be bumped
        const bumpableDeposits = analysis.deposits.filter(d => d.profitability.canBump);

        logger.info('Profitability Analysis:', {
          totalDeposits: deposits.length,
          bumpableDeposits: bumpableDeposits.length,
          totalExpectedProfit: ethers.formatEther(analysis.totalExpectedProfit)
        });

        if (bumpableDeposits.length > 0) {
          logger.info('Bumpable Deposits:', {
            deposits: bumpableDeposits.map(d => ({
              id: d.depositId.toString(),
              profit: ethers.formatEther(d.profitability.estimates.expectedProfit)
            }))
          });

          // Queue transactions if executor is available
          if (this.executor) {
            for (const result of bumpableDeposits) {
              try {
                await this.executor.queueTransaction(
                  result.depositId,
                  result.profitability
                );
                logger.info('Queued transaction for deposit', {
                  id: result.depositId.toString()
                });
              } catch (error) {
                logger.error('Failed to queue transaction', {
                  error,
                  depositId: result.depositId.toString()
                });
              }
            }
          }
        }
      } catch (error) {
        logger.error('Error in monitoring interval:', { error });
      }
    }, this.config.loggingInterval);
  }

  async runTestFlow() {
    logger.info('Running test flow...');

    // Schedule score updates at intervals
    const updateInterval = Math.floor(this.config.testDuration / 5);

    // First update - make one delegatee ineligible
    setTimeout(async () => {
      if (!this.isRunning) return;

      const deposits = await this.database.getAllDeposits();
      if (deposits.length > 0) {
        const deposit = deposits[0];
        if (deposit && deposit.delegatee_address) {
          await this.scoreSimulator.updateScore(
            deposit.delegatee_address,
            this.config.thresholdScore - 10
          );
          logger.info(`Made delegatee ${deposit.delegatee_address} ineligible`);
        }
      }
    }, updateInterval);

    // Second update - make another delegatee eligible again
    setTimeout(async () => {
      if (!this.isRunning) return;

      const deposits = await this.database.getAllDeposits();
      if (deposits.length > 1) {
        const deposit = deposits[1];
        if (deposit && deposit.delegatee_address) {
          await this.scoreSimulator.updateScore(
            deposit.delegatee_address,
            this.config.thresholdScore + 5
          );
          logger.info(`Made delegatee ${deposit.delegatee_address} eligible`);
        }
      }
    }, updateInterval * 2);

    // Third update - pause oracle temporarily
    setTimeout(async () => {
      if (!this.isRunning) return;

      await this.scoreSimulator.setOraclePaused(true);
      logger.info('Oracle paused temporarily');

      // Unpause after a short delay
      setTimeout(async () => {
        if (!this.isRunning) return;
        await this.scoreSimulator.setOraclePaused(false);
        logger.info('Oracle unpaused');
      }, 30000); // 30 seconds
    }, updateInterval * 3);

    // Fourth update - update all delegatees with random scores
    setTimeout(async () => {
      if (!this.isRunning) return;

      const deposits = await this.database.getAllDeposits();
      for (const deposit of deposits) {
        if (deposit.delegatee_address) {
          const score = Math.floor(Math.random() * 100);
          await this.scoreSimulator.updateScore(deposit.delegatee_address, score);
          logger.info(`Updated delegatee ${deposit.delegatee_address} to score ${score}`);
        }
      }
    }, updateInterval * 4);
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping test harness...');

    // Clear monitoring interval
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    // Stop components
    await this.calculator.stop();
    await this.profitability.stop();
    if (this.executor) {
      await this.executor.stop();
    }

    this.isRunning = false;
    logger.info('Test harness stopped');
  }
}

// Load configuration from environment variables or use defaults
const getConfig = (): TestHarnessConfig => {
  return {
    rpcUrl: process.env.RPC_URL || CONFIG.monitor.rpcUrl,
    stakerAddress: process.env.STAKER_ADDRESS || CONFIG.monitor.stakerAddress,
    calculatorAddress: process.env.CALCULATOR_ADDRESS || CONFIG.monitor.rewardCalculatorAddress,
    oraclePrivateKey: process.env.ORACLE_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    randomDelegatees: parseInt(process.env.RANDOM_DELEGATEES || '5', 10),
    specificDelegatees: process.env.SPECIFIC_DELEGATEES ?
      process.env.SPECIFIC_DELEGATEES.split(',').map(d => {
        const [address, scoreStr] = d.split(':');
        return { address: address || '', score: parseInt(scoreStr || '0', 10) };
      }) : [],
    thresholdScore: parseInt(process.env.THRESHOLD_SCORE || '75', 10),
    calculatorPollInterval: parseInt(process.env.CALCULATOR_POLL_INTERVAL || CONFIG.monitor.pollInterval.toString(), 10),
    testDuration: parseInt(process.env.TEST_DURATION || '300000', 10), // 5 minutes default
    loggingInterval: parseInt(process.env.LOGGING_INTERVAL || '10000', 10), // 10 seconds default
    databasePath: process.env.DATABASE_PATH || './test-harness-db.json'
  };
};

async function main() {
  // Get configuration
  const config = getConfig();

  // Validate required configuration
  if (!config.oraclePrivateKey) {
    logger.error('ORACLE_PRIVATE_KEY is required');
    process.exit(1);
  }

  if (!config.stakerAddress) {
    logger.error('STAKER_ADDRESS is required');
    process.exit(1);
  }

  if (!config.calculatorAddress) {
    logger.error('CALCULATOR_ADDRESS is required');
    process.exit(1);
  }

  logger.info('Starting test harness with configuration:', {
    stakerAddress: config.stakerAddress,
    calculatorAddress: config.calculatorAddress,
    randomDelegatees: config.randomDelegatees,
    specificDelegatees: config.specificDelegatees
  });

  // Create an instance of TestHarness
  const testHarness = new TestHarness(config);

  // Run the test
  await testHarness.runTest();
}

main();
