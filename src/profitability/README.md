# Profitability Engine Component

The Profitability Engine component is responsible for analyzing and determining whether deposits can be profitably bumped, considering calculator eligibility, reward constraints, gas costs, and batch optimization.

#### Overview

The profitability engine integrates with the [Staker Contract](https://github.com/withtally/staker/blob/main/src/Staker.sol) to determine initial bump eligibility and calculates optimal tips and batch sizes for profitable bump operations.

## Components

### ProfitabilityEngineWrapper

- Main entry point for profitability analysis functionality
- Implements strategy pattern to support different profitability calculation methods
- Manages engine state (running/stopped)
- Tracks gas price and update timestamps

### BaseProfitabilityEngine

- Default profitability engine implementation
- Validates bump requirements using calculator
- Calculates optimal tips based on gas costs
- Performs batch analysis and optimization
- Implements gas price buffering for volatility

## Configuration

The engine can be configured with the following parameters:

```typescript
type ProfitabilityConfig = {
  minProfitMargin: bigint; // Minimum profit margin in base units
  maxBatchSize: number; // Maximum number of deposits to process in a batch
  gasPriceBuffer: number; // Buffer percentage for gas price volatility
  minConfidence: number; // Minimum confidence level for gas price estimates
};
```

## Usage

### Initializing the Engine

```typescript
const engine = new ProfitabilityEngineWrapper(
  database,
  provider,
  stakerAddress,
  {
    minProfitMargin: BigInt(1e16), // 0.01 ETH
    maxBatchSize: 10,
    gasPriceBuffer: 20, // 20% buffer
    minConfidence: 90,
  },
);

await engine.start();
```

### Checking Single Deposit Profitability

```typescript
const profitability = await engine.checkProfitability(deposit);
console.log('Can bump:', profitability.canBump);
console.log('Optimal tip:', profitability.estimates.optimalTip.toString());
console.log(
  'Expected profit:',
  profitability.estimates.expectedProfit.toString(),
);
```

### Analyzing Batch Profitability

```typescript
const batchAnalysis = await engine.analyzeBatchProfitability(deposits);
console.log('Recommended batch size:', batchAnalysis.recommendedBatchSize);
console.log(
  'Total expected profit:',
  batchAnalysis.totalExpectedProfit.toString(),
);
```

## Integration Points

- BinaryEligibilityCalculator for bump eligibility checks
- Staker contract for reward and tip constraints
- Gas price oracle for cost estimation
- Database for deposit information

## Error Handling

- Validates contract interfaces
- Implements gas price buffering
- Handles failed profitability checks gracefully
- Provides detailed error logging

## Health Monitoring

The engine includes built-in status monitoring:

- Running state
- Last gas price
- Last update timestamp
- Batch processing statistics
