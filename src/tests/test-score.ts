/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers } from 'ethers';
import { CONFIG } from '../config';
import { ConsoleLogger } from '../monitor/logging';
import { config } from 'dotenv';
import type { Log as EthersLog } from 'ethers';

// Load .env.test file
config({ path: '.env.test' });

const logger = new ConsoleLogger('info');

// ABI fragment for the score oracle functions
const CALCULATOR_ABI = [
  'function updateDelegateeScore(address delegatee, uint256 newScore)',
  'function overrideDelegateeScore(address delegatee, uint256 newScore)',
  'function delegateeScores(address delegatee) view returns (uint256)',
  'function delegateeEligibilityThresholdScore() view returns (uint256)',
  'function updateEligibilityDelay() view returns (uint256)',
  'function setOracleState(bool pauseOracle)',
  'function isOraclePaused() view returns (bool)',
  'event DelegateeScoreUpdated(address indexed delegatee, uint256 oldScore, uint256 newScore)',
] as const;

interface SimulatorOptions {
  privateKey: string;
  rpcUrl: string;
  calculatorAddress: string;
  mode: 'random' | 'controlled';
  count?: number;
  minScore?: number;
  maxScore?: number;
  delegatees?: Array<string>;
  pauseOracle?: boolean;
}

interface DelegateeScoreEvent {
  name: string;
  args: {
    delegatee: string;
    oldScore: bigint;
    newScore: bigint;
  };
}

type Calculator = ethers.Contract & {
  delegateeEligibilityThresholdScore: () => Promise<bigint>;
  updateEligibilityDelay: () => Promise<bigint>;
  isOraclePaused: () => Promise<boolean>;
  setOracleState: (
    paused: boolean,
  ) => Promise<ethers.ContractTransactionResponse>;
  delegateeScores: (delegatee: string) => Promise<bigint>;
  updateDelegateeScore: (
    delegatee: string,
    score: number,
  ) => Promise<ethers.ContractTransactionResponse>;
  overrideDelegateeScore: (
    delegatee: string,
    score: number,
  ) => Promise<ethers.ContractTransactionResponse>;
};

class ScoreSimulator {
  private provider: ethers.Provider;
  private wallet: ethers.Wallet;
  private calculator: Calculator | null = null;
  private options: SimulatorOptions;
  private thresholdScore: bigint = BigInt(0);
  private eligibilityDelay: bigint = BigInt(0);

  constructor(options: SimulatorOptions) {
    this.options = options;
    this.provider = new ethers.JsonRpcProvider(options.rpcUrl);
    this.wallet = new ethers.Wallet(options.privateKey, this.provider);
    this.initializeCalculator();
  }

  private initializeCalculator() {
    this.calculator = new ethers.Contract(
      this.options.calculatorAddress,
      CALCULATOR_ABI,
      this.wallet,
    ) as Calculator;
  }

  private getCalculator(): Calculator {
    if (!this.calculator)
      throw new Error('Calculator contract not initialized');
    return this.calculator;
  }

  async initialize() {
    logger.info('Initializing score simulator...');

    try {
      const calculator = this.getCalculator();

      this.thresholdScore =
        await calculator.delegateeEligibilityThresholdScore();
      this.eligibilityDelay = await calculator.updateEligibilityDelay();
      const oraclePaused = await calculator.isOraclePaused();

      logger.info('Simulator initialized with contract parameters:', {
        thresholdScore: this.thresholdScore.toString(),
        eligibilityDelay: this.eligibilityDelay.toString(),
        oraclePaused,
      });
    } catch (error) {
      logger.error('Failed to initialize simulator:', { error });
      throw error;
    }
  }

  async setOraclePaused(paused: boolean) {
    logger.info(`Setting oracle pause state to ${paused}`);
    try {
      const calculator = this.getCalculator();

      const tx = await calculator.setOracleState(paused);
      await tx.wait();
      logger.info(`Oracle pause state updated to ${paused}`);
    } catch (error) {
      logger.error('Failed to set oracle pause state:', { error });
      throw error;
    }
  }

  async updateScore(delegatee: string, score: number) {
    logger.info(`Updating score for ${delegatee} to ${score}`);

    try {
      const calculator = this.getCalculator();

      // First check current score
      const currentScore = await calculator.delegateeScores(delegatee);
      logger.info(`Current score: ${currentScore.toString()}`);

      // Update score
      const tx = await calculator.updateDelegateeScore(delegatee, score);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt not found');

      // Find the event
      const event = receipt.logs
        .filter((log: EthersLog) => log.address === calculator.target)
        .map((log: EthersLog) => {
          try {
            const parsedLog = calculator.interface.parseLog(log);
            if (!parsedLog || parsedLog.name !== 'DelegateeScoreUpdated')
              return null;

            return {
              name: parsedLog.name,
              args: {
                delegatee: parsedLog.args[0] as string,
                oldScore: parsedLog.args[1] as bigint,
                newScore: parsedLog.args[2] as bigint,
              },
            } as DelegateeScoreEvent;
          } catch (e) {
            return null;
          }
        })
        .find(
          (event: DelegateeScoreEvent | null): event is DelegateeScoreEvent =>
            event?.name === 'DelegateeScoreUpdated',
        );

      if (event) {
        logger.info('Score updated successfully:', {
          delegatee: event.args.delegatee,
          oldScore: event.args.oldScore.toString(),
          newScore: event.args.newScore.toString(),
          tx: tx.hash,
        });
      } else {
        logger.warn('Score updated but no event found:', {
          delegatee,
          tx: tx.hash,
        });
      }

      return tx.hash;
    } catch (error) {
      logger.error('Failed to update score:', { error, delegatee });
      throw error;
    }
  }

  async overrideScore(delegatee: string, score: number) {
    logger.info(`Overriding score for ${delegatee} to ${score}`);

    try {
      // @ts-expect-error - Contract is initialized
      const tx = await this.calculator.overrideDelegateeScore(delegatee, score);
      await tx.wait();
      logger.info(`Score overridden for ${delegatee} to ${score}`);
      return tx.hash;
    } catch (error) {
      logger.error('Failed to override score:', { error, delegatee });
      throw error;
    }
  }

  async getRandomDelegatee() {
    // Generate a random wallet address for testing
    const randomWallet = ethers.Wallet.createRandom();
    return randomWallet.address;
  }

  async run() {
    await this.initialize();

    // Handle oracle pause if specified
    if (typeof this.options.pauseOracle !== 'undefined') {
      await this.setOraclePaused(this.options.pauseOracle);
    }

    if (this.options.mode === 'random') {
      await this.runRandomMode();
    } else {
      await this.runControlledMode();
    }
  }

  async runRandomMode() {
    const count = this.options.count || 5;
    const minScore = Math.max(0, this.options.minScore || 0);
    const maxScore = this.options.maxScore || 100;

    logger.info(`Running in random mode: generating ${count} score updates`);

    for (let i = 0; i < count; i++) {
      const delegatee = await this.getRandomDelegatee();
      const score =
        Math.floor(Math.random() * (maxScore - minScore + 1)) + minScore;

      // 50% chance of being above threshold
      if (Math.random() > 0.5) {
        await this.updateScore(delegatee, Number(this.thresholdScore) + score);
      } else {
        await this.updateScore(
          delegatee,
          Math.max(0, Number(this.thresholdScore) - score),
        );
      }

      // Small delay between transactions
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async runControlledMode() {
    const delegatees = this.options.delegatees || [];
    if (delegatees.length === 0) {
      logger.error('No delegatees specified for controlled mode');
      return;
    }

    logger.info(
      `Running in controlled mode for ${delegatees.length} delegatees`,
    );

    for (const delegatee of delegatees) {
      // Parse the delegatee:score format
      const [address, scoreStr] = delegatee.split(':');
      if (!address) {
        logger.warn(`Invalid delegatee format: ${delegatee}, skipping`);
        continue;
      }

      const score = parseInt(scoreStr || '0', 10);

      if (isNaN(score)) {
        logger.warn(`Invalid score format for ${delegatee}, skipping`);
        continue;
      }

      await this.updateScore(address, score);

      // Small delay between transactions
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Create test scenarios for specific testing needs
  async runEligibilityTestScenario() {
    logger.info('Running eligibility test scenario');

    // Create a scenario with 5 delegatees
    const delegatees: string[] = [];
    for (let i = 0; i < 5; i++) {
      delegatees.push(await this.getRandomDelegatee());
    }

    // Scenario 1: All delegatees start above threshold
    for (const delegatee of delegatees) {
      await this.updateScore(delegatee, Number(this.thresholdScore) + 10);
    }

    // Wait a bit for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Scenario 2: Two delegatees fall below threshold
    if (delegatees.length > 1) {
      await this.updateScore(delegatees[0]!, Number(this.thresholdScore) - 10);
      await this.updateScore(delegatees[1]!, Number(this.thresholdScore) - 5);
    }

    // Wait a bit for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Scenario 3: One delegatee goes back above threshold
    if (delegatees.length > 0) {
      await this.updateScore(delegatees[0]!, Number(this.thresholdScore) + 5);
    }

    logger.info('Eligibility test scenario completed');
  }
}

async function main() {
  // Load configuration from .env.test or use defaults
  const options: SimulatorOptions = {
    privateKey:
      process.env.ORACLE_PRIVATE_KEY ||
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    rpcUrl: process.env.RPC_URL || CONFIG.monitor.rpcUrl,
    calculatorAddress:
      process.env.CALCULATOR_ADDRESS || CONFIG.monitor.rewardCalculatorAddress,
    mode: (process.argv[2] as 'random' | 'controlled') || 'random',
    count: parseInt(process.env.UPDATE_COUNT || '5', 10),
    minScore: parseInt(process.env.MIN_SCORE || '0', 10),
    maxScore: parseInt(process.env.MAX_SCORE || '100', 10),
  };

  // Parse delegatees if provided
  if (process.env.DELEGATEES) {
    options.delegatees = process.env.DELEGATEES.split(',');
  }

  // Parse oracle pause state if provided
  if (process.env.PAUSE_ORACLE) {
    options.pauseOracle = process.env.PAUSE_ORACLE === 'true';
  }

  // Handle command line arguments
  if (process.argv.length > 3 && options.mode === 'controlled') {
    options.delegatees = process.argv.slice(3);
  }

  // Special test scenario
  if (process.argv[2] === 'test-scenario') {
    const simulator = new ScoreSimulator(options);
    await simulator.runEligibilityTestScenario();
    return;
  }

  // Validate required options
  if (!options.privateKey) {
    logger.error('ORACLE_PRIVATE_KEY is required');
    process.exit(1);
  }

  if (!options.calculatorAddress) {
    logger.error('CALCULATOR_ADDRESS is required');
    process.exit(1);
  }

  // Run the simulator
  const simulator = new ScoreSimulator(options);
  await simulator.run();
}

// Run the script if called directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('Error in score simulator:', { error });
      process.exit(1);
    });
}

// Export for programmatic usage
export { ScoreSimulator, SimulatorOptions };
