import { ethers } from 'ethers';
import { BinaryEligibilityOracleEarningPowerCalculator } from '../calculator';
import { BaseProfitabilityEngine } from '../profitability/strategies/BaseProfitabilityEngine';
import { ProfitabilityConfig } from '../profitability/interfaces/types';
import { IDatabase } from '../database';
import fs from 'fs';
import 'dotenv/config';

// Mock database adapter for testing
class MockDatabase implements IDatabase {
  async createScoreEvent() { return; }
  async getLatestScoreEvent() { return null; }
  async getScoreEventsByBlockRange() { return []; }
  async updateCheckpoint() { return; }
  async createDeposit() { return; }
  async getDeposit() { return null; }
  async getDepositsByDelegatee() { return []; }
  async updateDeposit() { return; }
  async deleteDeposit() { return; }
  async updateScoreEvent() { return; }
  async deleteScoreEvent() { return; }
  async deleteScoreEventsByBlockRange() { return; }
  async getScoreEvent() { return null; }
  async getCheckpoint() { return null; }
}

async function main() {
  console.log('Starting profitability test...');

  // Load database
  console.log('Loading staker-monitor database...');
  const dbPath = './staker-monitor-db.json';
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));

  // Convert deposits to the correct format
  console.log('Converting deposits to the correct format...');
  const deposits = Object.values(db.deposits).map((deposit: any) => {
    console.log(`Processing deposit ${deposit.deposit_id}:`, {
      amount: deposit.amount,
      earning_power: deposit.earning_power,
      owner: deposit.owner_address,
      delegatee: deposit.delegatee_address
    });
    return {
      deposit_id: BigInt(deposit.deposit_id),
      amount: BigInt(deposit.amount),
      earning_power: deposit.earning_power ? BigInt(deposit.earning_power) : undefined,
      owner_address: deposit.owner_address,
      delegatee_address: deposit.delegatee_address,
    };
  });
  console.log(`Loaded ${deposits.length} deposits from database`);

  // Initialize provider
  console.log('Initializing provider...');
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const network = await provider.getNetwork();
  console.log('Connected to network:', {
    chainId: network.chainId,
    name: network.name
  });

  // Initialize staker contract
  console.log('Initializing staker contract...');
  const stakerAddress = process.env.STAKER_CONTRACT_ADDRESS;
  const stakerAbi = JSON.parse(fs.readFileSync('./abis/staker.json', 'utf-8'));
  const stakerContract = new ethers.Contract(
    stakerAddress!,
    stakerAbi,
    provider,
  );
  console.log('Staker contract initialized at:', stakerAddress);

  // Test contract read functions
  console.log('Testing contract read functions...');
  try {
    const typedContract = stakerContract as ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
      maxBumpTip(): Promise<bigint>;
      bumpEarningPower(depositId: bigint, tip: bigint): Promise<bigint>;
    };

    const maxBumpTip = await typedContract.maxBumpTip();
    console.log('Max bump tip:', ethers.formatEther(maxBumpTip), 'ETH');

    // Test reading first deposit
    const firstDeposit = deposits[0];
    if (firstDeposit) {
      const depositInfo = await typedContract.deposits(firstDeposit.deposit_id);
      console.log('First deposit info:', {
        id: firstDeposit.deposit_id.toString(),
        owner: depositInfo.owner,
        balance: ethers.formatEther(depositInfo.balance),
        earningPower: ethers.formatEther(depositInfo.earningPower),
        delegatee: depositInfo.delegatee,
      });

      const unclaimedReward = await typedContract.unclaimedReward(firstDeposit.deposit_id);
      console.log('Unclaimed reward:', ethers.formatEther(unclaimedReward), 'ETH');
    }
  } catch (error) {
    console.error('Error testing contract read functions:', error);
    throw error;
  }

  // Initialize calculator
  console.log('Initializing calculator...');
  const calculator = new BinaryEligibilityOracleEarningPowerCalculator(
    new MockDatabase(),
    provider,
  );

  // Configure profitability engine
  console.log('Configuring profitability engine...');
  const config: ProfitabilityConfig = {
    minProfitMargin: BigInt(1e16), // 0.01 ETH
    gasPriceBuffer: 20, // 20%
    maxBatchSize: 10,
    minConfidence: 90,
    defaultTipReceiver: process.env.TIP_RECEIVER || ethers.ZeroAddress,
  };
  console.log('Profitability config:', {
    minProfitMargin: ethers.formatEther(config.minProfitMargin),
    gasPriceBuffer: config.gasPriceBuffer,
    maxBatchSize: config.maxBatchSize,
    tipReceiver: config.defaultTipReceiver,
  });

  // Initialize profitability engine
  console.log('Initializing profitability engine...');
  const profitabilityEngine = new BaseProfitabilityEngine(
    calculator,
    stakerContract as any,
    provider,
    config,
  );

  // Start the engine
  await profitabilityEngine.start();
  console.log('Profitability engine started');

  console.log(`\nAnalyzing ${deposits.length} deposits for profitability...`);
  try {
    // Analyze batch profitability
    const batchAnalysis = await profitabilityEngine.analyzeBatchProfitability(
      deposits,
    );

    // Print results
    console.log('\nBatch Analysis Results:');
    console.log('------------------------');
    console.log(
      `Total Gas Estimate: ${ethers.formatEther(batchAnalysis.totalGasEstimate)} ETH`,
    );
    console.log(
      `Total Expected Profit: ${ethers.formatEther(
        batchAnalysis.totalExpectedProfit,
      )} ETH`,
    );
    console.log(`Recommended Batch Size: ${batchAnalysis.recommendedBatchSize}`);

    console.log('\nDeposit Results:');
    console.log('----------------');
    batchAnalysis.deposits.forEach((result) => {
      console.log(`\nDeposit ID: ${result.depositId}`);
      console.log(`Can Bump: ${result.profitability.canBump}`);
      console.log('Constraints:', result.profitability.constraints);
      if (result.profitability.canBump) {
        console.log(
          `Optimal Tip: ${ethers.formatEther(
            result.profitability.estimates.optimalTip,
          )} ETH`,
        );
        console.log(
          `Gas Estimate: ${ethers.formatEther(
            result.profitability.estimates.gasEstimate,
          )} ETH`,
        );
        console.log(
          `Expected Profit: ${ethers.formatEther(
            result.profitability.estimates.expectedProfit,
          )} ETH`,
        );
      }
    });
  } catch (error) {
    console.error('Error during profitability analysis:', error);
    throw error;
  }

  // Stop the engine
  await profitabilityEngine.stop();
  console.log('\nProfitability engine stopped');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
