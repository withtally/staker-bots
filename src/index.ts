import { DatabaseWrapper } from '@/database';
import { CONFIG, createProvider } from '@/config';
import { ConsoleLogger } from '@/monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { CalculatorWrapper } from './calculator/CalculatorWrapper';
import { ExecutorWrapper, ExecutorType } from './executor';
import { ProfitabilityEngineWrapper } from './profitability';
import { ProfitabilityCheck } from './profitability/interfaces/types';
import { ethers } from 'ethers';
import { STAKER_ABI } from './monitor/constants';
import { EventEmitter } from 'events';
import { DelegateeAlteredEvent } from './monitor/types';
import { Deposit } from '@/database/interfaces/types';

const logger = new ConsoleLogger('info');

// Extended interfaces
interface ExtendedDeposit extends Deposit {
  earning_power?: string;
  is_eligible?: boolean;
  profitability_checked?: boolean;
  is_profitable?: boolean;
  execution_queued?: boolean;
  optimal_tip?: string;
  expected_profit?: string;
}

// Status interface for monitoring
interface ComponentStatus {
  isRunning: boolean;
  lastProcessedBlock?: number;
  currentChainBlock?: number;
  processingLag?: number;
  lastError?: Error;
  lastSuccessfulRun?: Date;
}

interface SystemStatus {
  isRunning: boolean;
  errorCount: number;
  lastErrorTime: number;
  components: {
    monitor: ComponentStatus;
    calculator: ComponentStatus;
    profitability: ComponentStatus;
    executor: ComponentStatus;
  };
}

// Extend DatabaseWrapper interface
interface ExtendedDatabaseWrapper extends DatabaseWrapper {
  getUnprocessedDeposits(limit: number): Promise<ExtendedDeposit[]>;
  getEligibleDeposits(limit: number): Promise<ExtendedDeposit[]>;
  getProfitableDeposits(limit: number): Promise<ExtendedDeposit[]>;
  updateDepositProfitability(
    depositId: string,
    profitability: ProfitabilityCheck,
  ): Promise<void>;
  updateDeposit(
    depositId: string,
    update: Partial<ExtendedDeposit>,
  ): Promise<void>;
}

// Configuration for the orchestrator
interface OrchestratorConfig {
  // Core configurations
  startBlock: number;
  confirmations: number;
  maxBlockRange: number;

  // Processing configs
  batchSize: number;
  retryAttempts: number;
  retryDelay: number;

  // Performance tuning
  maxConcurrentProcessing: number;
  processingTimeout: number;

  // Circuit breaker configs
  maxErrorThreshold: number;
  errorTimeWindow: number;
}

// StakerBotOrchestrator class - Central coordinator of all components
class StakerBotOrchestrator extends EventEmitter {
  private isRunning: boolean = false;
  private errorCount: number = 0;
  private lastErrorTime: number = 0;
  private intervalHandles: NodeJS.Timeout[] = [];

  // Processing state
  private processingInterval: NodeJS.Timeout | null = null;
  private readonly PROCESSING_INTERVAL = 5000; // 5 seconds between checks
  private readonly BATCH_SIZE = 10; // Number of items to process per component cycle

  // Component timing thresholds
  private lastCalculatorRun: number = 0;
  private readonly CALCULATOR_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
  private readonly MIN_DEPOSITS_FOR_PROFITABILITY = 5; // Minimum deposits to trigger profitability check

  constructor(
    private readonly monitor: StakerMonitor,
    private readonly calculator: CalculatorWrapper,
    private readonly profitabilityEngine: ProfitabilityEngineWrapper,
    private readonly executor: ExecutorWrapper,
    private readonly database: ExtendedDatabaseWrapper,
    private readonly logger: ConsoleLogger,
    private readonly config: OrchestratorConfig,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Orchestrator is already running');
      return;
    }

    try {
      this.logger.info('Starting StakerBot Orchestrator');

      // Initialize components in correct order but don't start continuous processing
      this.logger.info('Initializing calculator...');
      await this.calculator.start();

      this.logger.info('Initializing profitability engine...');
      await this.profitabilityEngine.start();

      this.logger.info('Initializing executor...');
      await this.executor.start();

      this.logger.info('Initializing monitor...');
      await this.monitor.start();

      // Set up event handlers
      this.monitor.on('delegateeAltered', this.handleDelegateEvent.bind(this));
      this.monitor.on('error', this.handleError.bind(this));

      // Set up health check intervals
      this.setupHealthChecks();

      // Start round-robin processing
      this.startProcessingCycle();

      this.isRunning = true;
      this.emit('started');
      this.logger.info('StakerBot Orchestrator started successfully');
    } catch (error) {
      this.logger.error('Failed to start orchestrator', { error });
      throw error;
    }
  }

  private startProcessingCycle(): void {
    this.processingInterval = setInterval(async () => {
      try {
        await this.processComponents();
      } catch (error) {
        this.logger.error('Error in processing cycle:', { error });
        await this.handleError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }, this.PROCESSING_INTERVAL);
  }

  private async processComponents(): Promise<void> {
    // Always process monitor more frequently
    const shouldProcessMonitor = Math.random() < 0.75; // 75% chance to process monitor
    if (shouldProcessMonitor) {
      await this.processMonitor();
      return;
    }

    // Check if calculator needs to run (every 6 hours)
    const now = Date.now();
    if (now - this.lastCalculatorRun >= this.CALCULATOR_INTERVAL) {
      this.logger.info('Running calculator (6-hour interval)');
      await this.processCalculator();
      this.lastCalculatorRun = now;

      // Get count of eligible deposits after calculator run
      const eligibleDeposits = await this.database.getEligibleDeposits(100); // Get up to 100 to check threshold

      // If we have enough eligible deposits, run profitability check
      if (eligibleDeposits.length >= this.MIN_DEPOSITS_FOR_PROFITABILITY) {
        this.logger.info(
          `Running profitability check for ${eligibleDeposits.length} eligible deposits`,
        );
        await this.processProfitability();
      }
      return;
    }

    // Check for profitable transactions and run executor if any exist
    const profitableDeposits = await this.database.getProfitableDeposits(1); // Just check if any exist
    if (profitableDeposits.length > 0) {
      this.logger.info('Found profitable deposits, running executor');
      await this.processExecutor();
      return;
    }

    // If nothing else to do, process monitor again
    await this.processMonitor();
  }

  private async processMonitor(): Promise<void> {
    const status = await this.monitor.getMonitorStatus();
    if (!status.isRunning) return;

    // Process a batch of blocks
    const currentBlock = status.currentChainBlock;
    const lastProcessed = status.lastProcessedBlock;

    if (currentBlock > lastProcessed) {
      this.logger.info('Processing new blocks', {
        currentBlock,
        lastProcessed,
        lag: currentBlock - lastProcessed,
      });
    }
  }

  private async processCalculator(): Promise<void> {
    const status = await this.calculator.getStatus();
    if (!status.isRunning) return;

    // Get unprocessed deposits from database
    const unprocessedDeposits = await this.database.getUnprocessedDeposits(
      this.BATCH_SIZE,
    );

    if (unprocessedDeposits.length === 0) {
      this.logger.info('No unprocessed deposits to calculate');
      return;
    }

    this.logger.info(
      `Processing ${unprocessedDeposits.length} deposits for calculation`,
    );
    for (const deposit of unprocessedDeposits) {
      if (!deposit.delegatee_address) continue; // Skip deposits without delegatee

      const [newEarningPower, isEligible] =
        await this.calculator.getNewEarningPower(
          BigInt(deposit.amount),
          deposit.owner_address,
          deposit.delegatee_address,
          BigInt(deposit.earning_power || '0'),
        );

      // Store the calculation result
      await this.database.updateDeposit(deposit.deposit_id, {
        earning_power: newEarningPower.toString(),
        is_eligible: isEligible,
      });
    }
  }

  private async processProfitability(): Promise<void> {
    const status = await this.profitabilityEngine.getStatus();
    if (!status.isRunning) return;

    // Get eligible deposits that need profitability analysis
    const eligibleDeposits = await this.database.getEligibleDeposits(
      this.BATCH_SIZE,
    );

    if (eligibleDeposits.length === 0) {
      this.logger.info('No eligible deposits for profitability analysis');
      return;
    }

    this.logger.info(
      `Processing ${eligibleDeposits.length} deposits for profitability`,
    );
    const validDeposits = eligibleDeposits.filter(
      (d) => d.delegatee_address !== null,
    );

    if (validDeposits.length === 0) return;

    // Process each deposit individually for profitability
    for (const deposit of validDeposits) {
      const profitability = await this.profitabilityEngine.checkProfitability({
        deposit_id: BigInt(deposit.deposit_id),
        amount: BigInt(deposit.amount),
        owner_address: deposit.owner_address,
        delegatee_address: deposit.delegatee_address as string,
      });

      await this.database.updateDepositProfitability(
        deposit.deposit_id,
        profitability,
      );
    }
  }

  private async processExecutor(): Promise<void> {
    const status = await this.executor.getStatus();
    if (!status.isRunning) return;

    // Get profitable deposits ready for execution
    const profitableDeposits = await this.database.getProfitableDeposits(
      this.BATCH_SIZE,
    );

    if (profitableDeposits.length === 0) {
      this.logger.info('No profitable deposits ready for execution');
      return;
    }

    this.logger.info(
      `Processing ${profitableDeposits.length} profitable deposits for execution`,
    );
    for (const deposit of profitableDeposits) {
      const profitability = await this.profitabilityEngine.checkProfitability({
        deposit_id: BigInt(deposit.deposit_id),
        amount: BigInt(deposit.amount),
        owner_address: deposit.owner_address,
        delegatee_address: deposit.delegatee_address,
      });

      if (profitability.canBump) {
        await this.executor.queueTransaction(
          BigInt(deposit.deposit_id),
          profitability,
        );
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping StakerBot Orchestrator');
    this.isRunning = false;

    // Clear all interval handles
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    for (const handle of this.intervalHandles) {
      clearInterval(handle);
    }
    this.intervalHandles = [];

    try {
      // Stop in reverse order of startup
      this.logger.info('Stopping monitor...');
      await this.monitor.stop();

      this.logger.info('Stopping executor...');
      await this.executor.stop();

      this.logger.info('Stopping profitability engine...');
      await this.profitabilityEngine.stop();

      this.logger.info('Stopping calculator...');
      await this.calculator.stop();

      this.emit('stopped');
      this.logger.info('StakerBot Orchestrator stopped successfully');
    } catch (error) {
      this.logger.error('Error during orchestrator shutdown', { error });
      throw error;
    }
  }

  private async handleDelegateEvent(
    event: DelegateeAlteredEvent,
  ): Promise<void> {
    try {
      this.logger.info('Processing delegatee altered event', {
        depositId: event.depositId.toString(),
        oldDelegatee: event.oldDelegatee,
        newDelegatee: event.newDelegatee,
        blockNumber: event.blockNumber,
      });

      // Get affected deposit
      const deposit = await this.database.getDeposit(
        event.depositId.toString(),
      );
      if (!deposit) {
        this.logger.warn('Deposit not found for event', {
          depositId: event.depositId.toString(),
        });
        return;
      }

      // 1. Update scores via calculator
      const [newEarningPower, isEligible] =
        await this.calculator.getNewEarningPower(
          BigInt(deposit.amount),
          deposit.owner_address,
          event.newDelegatee,
          BigInt(0), // Default to zero since earning_power isn't in the Deposit interface
        );

      // Store score update and eligibility
      await this.database.createScoreEvent({
        delegatee: event.newDelegatee,
        score: newEarningPower.toString(),
        block_number: event.blockNumber,
      });

      // Update deposit with new earning power and eligibility
      await this.database.updateDeposit(deposit.deposit_id, {
        earning_power: newEarningPower.toString(),
        is_eligible: isEligible,
      });

      // 2. Check profitability
      const convertedDeposit = {
        deposit_id: BigInt(deposit.deposit_id),
        amount: BigInt(deposit.amount),
        owner_address: deposit.owner_address,
        delegatee_address: deposit.delegatee_address,
        // Add any other required properties
      };

      const profitabilityCheck =
        await this.profitabilityEngine.checkProfitability(convertedDeposit);

      // 3. Queue transaction if profitable
      if (profitabilityCheck.canBump) {
        await this.executor.queueTransaction(
          BigInt(deposit.deposit_id),
          profitabilityCheck,
        );

        this.logger.info('Queued profitable bump transaction', {
          depositId: deposit.deposit_id,
          profit: profitabilityCheck.estimates.expectedProfit.toString(),
          tipAmount: profitabilityCheck.estimates.optimalTip.toString(),
        });
      } else {
        this.logger.info('Deposit not profitable for bumping', {
          depositId: deposit.deposit_id,
          constraints: profitabilityCheck.constraints,
        });
      }

      this.emit('processedDelegateEvent', {
        event,
        success: true,
      });
    } catch (error) {
      this.logger.error('Error handling delegate event', {
        error,
        event,
      });
      await this.handleError(
        error instanceof Error ? error : new Error(String(error)),
      );

      this.emit('processedDelegateEvent', {
        event,
        success: false,
        error,
      });
    }
  }

  private async handleError(error: Error): Promise<void> {
    this.errorCount++;
    const now = Date.now();

    // Reset error count if outside time window
    if (now - this.lastErrorTime > this.config.errorTimeWindow) {
      this.errorCount = 1;
    }
    this.lastErrorTime = now;

    // Check circuit breaker
    if (this.errorCount >= this.config.maxErrorThreshold) {
      this.logger.error('Error threshold exceeded, stopping orchestrator', {
        errorCount: this.errorCount,
        timeWindow: this.config.errorTimeWindow,
      });

      await this.stop();
      this.emit('circuitBreaker', { error, errorCount: this.errorCount });
    }
  }

  // Add monitoring and health check methods
  async getStatus(): Promise<SystemStatus> {
    return {
      isRunning: this.isRunning,
      errorCount: this.errorCount,
      lastErrorTime: this.lastErrorTime,
      components: {
        monitor: await this.monitor.getMonitorStatus(),
        calculator: await this.calculator.getStatus(),
        profitability: await this.profitabilityEngine.getStatus(),
        executor: await this.executor.getStatus(),
      },
    };
  }

  // Useful for testing and manual intervention
  async reprocessBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<{
    success: boolean;
    processedBlocks: number;
    processedEvents: number;
    error?: Error;
  }> {
    this.logger.info('Reprocessing block range', { fromBlock, toBlock });

    try {
      // Clear existing data for range
      await this.database.deleteScoreEventsByBlockRange(fromBlock, toBlock);

      // Instead of using monitor's processBlockRange method directly,
      // stop and restart the monitor with appropriate block range
      await this.monitor.stop();

      // Update checkpoint in database to start from the specified block
      await this.database.updateCheckpoint({
        component_type: 'staker-monitor',
        last_block_number: fromBlock - 1,
        block_hash:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        last_update: new Date().toISOString(),
      });

      // Start the monitor again, which will process from the checkpoint
      await this.monitor.start();

      return {
        success: true,
        processedBlocks: toBlock - fromBlock + 1,
        processedEvents: 0, // We don't have access to event count
      };
    } catch (error) {
      this.logger.error('Error reprocessing block range', {
        error,
        fromBlock,
        toBlock,
      });

      return {
        success: false,
        error: error as Error,
        processedBlocks: 0,
        processedEvents: 0,
      };
    }
  }

  // Helper method to check if transaction was profitable
  async verifyTransactionProfitability(txHash: string): Promise<{
    profitable: boolean;
    expectedProfit: bigint;
    actualProfit: bigint;
    gasUsed: bigint;
  }> {
    const receipt = await this.executor.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`Transaction ${txHash} not found`);
    }

    // Get profitability estimate from database
    const tx = await this.executor.getTransaction(txHash);
    if (!tx) {
      throw new Error(`Transaction ${txHash} not found in executor queue`);
    }

    // Calculate actual profit from receipt data
    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? 0);
    const gasUsed = BigInt(receipt.gasUsed);
    const gasCost = effectiveGasPrice * gasUsed;
    const actualProfit =
      (tx.profitability?.estimates?.expectedProfit ?? BigInt(0)) - gasCost;
    const expectedProfit =
      tx.profitability?.estimates?.expectedProfit ?? BigInt(0);

    return {
      profitable: actualProfit > gasUsed,
      expectedProfit,
      actualProfit,
      gasUsed,
    };
  }

  private setupHealthChecks(): void {
    // Schedule health checks for all components
    const healthCheckInterval = CONFIG.monitor.healthCheckInterval * 1000;

    // Monitor health check
    const monitorHealthCheck = setInterval(async () => {
      try {
        const status = await this.monitor.getMonitorStatus();
        this.logger.info('Monitor Status:', {
          isRunning: status.isRunning,
          processingLag: status.processingLag,
          currentBlock: status.currentChainBlock,
          lastProcessedBlock: status.lastProcessedBlock,
        });
      } catch (error) {
        this.logger.error('Monitor health check failed:', { error });
      }
    }, healthCheckInterval);
    this.intervalHandles.push(monitorHealthCheck);

    // Add other health checks as needed...
  }
}

// Extended database implementation
class ExtendedDatabaseWrapperImpl
  extends DatabaseWrapper
  implements ExtendedDatabaseWrapper
{
  async getUnprocessedDeposits(limit: number): Promise<ExtendedDeposit[]> {
    const deposits = await this.getAllDeposits();
    return deposits
      .filter((d) => {
        const extDeposit = d as ExtendedDeposit;
        return (
          !extDeposit.earning_power || extDeposit.is_eligible === undefined
        );
      })
      .slice(0, limit) as ExtendedDeposit[];
  }

  async getEligibleDeposits(limit: number): Promise<ExtendedDeposit[]> {
    const deposits = await this.getAllDeposits();
    return deposits
      .filter((d) => {
        const extDeposit = d as ExtendedDeposit;
        return extDeposit.is_eligible && !extDeposit.profitability_checked;
      })
      .slice(0, limit) as ExtendedDeposit[];
  }

  async getProfitableDeposits(limit: number): Promise<ExtendedDeposit[]> {
    const deposits = await this.getAllDeposits();
    return deposits
      .filter((d) => {
        const extDeposit = d as ExtendedDeposit;
        return extDeposit.is_profitable && !extDeposit.execution_queued;
      })
      .slice(0, limit) as ExtendedDeposit[];
  }

  async updateDepositProfitability(
    depositId: string,
    profitability: ProfitabilityCheck,
  ): Promise<void> {
    const deposit = await this.getDeposit(depositId);
    if (!deposit) return;

    await this.updateDeposit(depositId, {
      profitability_checked: true,
      is_profitable: profitability.canBump,
      optimal_tip: profitability.estimates?.optimalTip.toString(),
      expected_profit: profitability.estimates?.expectedProfit.toString(),
    });
  }

  async updateDeposit(
    depositId: string,
    update: Partial<ExtendedDeposit>,
  ): Promise<void> {
    const deposit = await this.getDeposit(depositId);
    if (!deposit) return;

    await super.updateDeposit(depositId, {
      ...deposit,
      ...update,
    });
  }
}

// Central orchestrator instance
let orchestrator: StakerBotOrchestrator | null = null;

async function shutdown(signal: string) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  try {
    if (orchestrator) {
      await orchestrator.stop();
    }
    logger.info('Shutdown completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', { error });
    process.exit(1);
  }
}

async function main() {
  try {
    // Initialize database with extended functionality
    const database = new ExtendedDatabaseWrapperImpl({
      type: CONFIG.monitor.databaseType,
    });

    // Create provider
    const provider = createProvider();

    // Test provider connection
    try {
      const network = await provider.getNetwork();
      logger.info('Connected to network:', {
        chainId: network.chainId,
        name: network.name,
      });
    } catch (error) {
      logger.error('Failed to connect to provider:', { error });
      throw error;
    }

    // Initialize staker contract
    const stakerContract = new ethers.Contract(
      CONFIG.monitor.stakerAddress,
      STAKER_ABI,
      provider,
    );

    // Initialize monitor with extended functionality
    const monitor = new StakerMonitor(createMonitorConfig(provider, database));

    // Initialize calculator
    const calculator = new CalculatorWrapper(database, provider);

    // Initialize profitability engine
    const profitabilityEngine = new ProfitabilityEngineWrapper(
      database,
      provider,
      CONFIG.monitor.stakerAddress,
    );

    // Initialize executor
    const executor = new ExecutorWrapper(
      stakerContract,
      provider,
      ExecutorType.WALLET,
      {
        wallet: {
          privateKey: CONFIG.executor.privateKey,
          minBalance: ethers.parseEther('0.1'), // 0.1 ETH
          maxPendingTransactions: 5,
        },
        maxQueueSize: 100,
        minConfirmations: CONFIG.monitor.confirmations,
        maxRetries: CONFIG.monitor.maxRetries,
        retryDelayMs: 5000,
        transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
        gasBoostPercentage: 10, // 10%
        concurrentTransactions: 3,
      },
    );

    // Create orchestrator configuration
    const orchestratorConfig: OrchestratorConfig = {
      startBlock: CONFIG.monitor.startBlock,
      confirmations: CONFIG.monitor.confirmations,
      maxBlockRange: CONFIG.monitor.maxBlockRange,
      batchSize: 10,
      retryAttempts: CONFIG.monitor.maxRetries,
      retryDelay: 5000,
      maxConcurrentProcessing: 3,
      processingTimeout: 60000, // 1 minute
      maxErrorThreshold: 5,
      errorTimeWindow: 60000 * 5, // 5 minutes
    };

    // Create and start the orchestrator with extended implementations
    orchestrator = new StakerBotOrchestrator(
      monitor,
      calculator,
      profitabilityEngine,
      executor,
      database,
      logger,
      orchestratorConfig,
    );

    // Only start if any components are enabled
    const components = (process.env.COMPONENTS || '')
      .split(',')
      .map((c) => c.trim());

    if (components.length === 0) {
      throw new Error(
        'No components configured to run. Set COMPONENTS env var.',
      );
    }

    // Start the orchestrator, which will start all components
    await orchestrator.start();
    logger.info('Staker Bot System started with components:', { components });

    // Register shutdown handlers
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
