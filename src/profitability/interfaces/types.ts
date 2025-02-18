export type Deposit = {
  deposit_id: bigint;
  owner_address: string;
  delegatee_address: string;
  amount: bigint;
  earning_power?: bigint;
  created_at?: string;
  updated_at?: string;
};

export type ProfitabilityCheck = {
  canBump: boolean;
  constraints: {
    calculatorEligible: boolean;
    hasEnoughRewards: boolean;
    isProfitable: boolean;
  };
  estimates: {
    optimalTip: bigint;
    gasEstimate: bigint;
    expectedProfit: bigint;
    tipReceiver: string;
  };
};

export type BatchAnalysis = {
  deposits: {
    depositId: bigint;
    profitability: ProfitabilityCheck;
  }[];
  totalGasEstimate: bigint;
  totalExpectedProfit: bigint;
  recommendedBatchSize: number;
};

export type TipOptimization = {
  optimalTip: bigint;
  expectedProfit: bigint;
  gasEstimate: bigint;
};

export type BumpRequirements = {
  isEligible: boolean;
  newEarningPower: bigint;
  unclaimedRewards: bigint;
  maxBumpTip: bigint;
};

export type GasPriceEstimate = {
  price: bigint;
  confidence: number;
  timestamp: number;
};

export type ProfitabilityConfig = {
  minProfitMargin: bigint; // Minimum profit margin in base units
  maxBatchSize: number; // Maximum number of deposits to process in a batch
  gasPriceBuffer: number; // Buffer percentage for gas price volatility
  minConfidence: number; // Minimum confidence level for gas price estimates
  defaultTipReceiver: string; // Default address to receive tips for bumps
};
