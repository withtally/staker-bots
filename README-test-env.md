# Staker Bots Test Environment

This document describes how to set up and use the test environment for the staker-bots project. The test environment deploys local versions of the required contracts and provides tools to simulate real-world scenarios.

## Prerequisites

- [Node.js](https://nodejs.org/) (v16+)
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (includes Anvil, Forge, and Cast)
- [jq](https://stedolan.github.io/jq/download/) for JSON processing in scripts

## Setup

1. **Clone the repository with submodules**:

   ```bash
   git clone --recurse-submodules <repository-url>
   cd staker-bots
   ```

   If you already cloned without submodules, use:

   ```bash
   git submodule update --init --recursive
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Set up the test environment**:

   ```bash
   npm run setup:test-env
   ```

   This command:

   - Starts a local Anvil node (if not already running)
   - Deploys test versions of the contracts
   - Creates a `.env.test` file with the necessary configuration
   - Initializes test data (delegatees, scores, and deposits)

## Using the Test Environment

### Running the Full Test Harness

The test harness runs the bot against the test environment and executes various test scenarios:

```bash
npm run test:harness
```

This will:

1. Start the bot with test configuration
2. Run through predefined test scenarios (eligibility changes, random updates, oracle pauses)
3. Check the results and stop the bot when done

### Running Individual Test Scenarios

You can run specific test scenarios independently:

```bash
npm run test:scenario eligibility_changes
npm run test:scenario random_updates
npm run test:scenario oracle_pause
```

### Checking the Database State

To view the current state of the database:

```bash
npm run test:check
```

### Updating Delegatee Scores Manually

You can update delegatee scores manually:

```bash
npm run update-score <delegatee-address> <score>
```

Example:

```bash
npm run update-score 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 85
```

### Running the Bot with Test Configuration

To run just the bot against the test environment:

```bash
npm test
```

## Stopping the Test Environment

To stop the local Anvil node when you're done testing:

```bash
kill $(cat anvil.pid)
```

## Troubleshooting

### Checking Anvil Node Status

```bash
lsof -i :8545
```

### Restarting the Test Environment

If you encounter issues, you can clean up and restart:

```bash
kill $(cat anvil.pid) # Stop anvil
rm -f test-staker-monitor-db.json # Remove test database
npm run setup:test-env # Set up test environment again
```

### Inspecting Contract State

You can use cast to inspect contract state:

```bash
# Get delegatee score
cast call $REWARD_CALCULATOR_ADDRESS "delegateeScores(address)" <delegatee-address> --rpc-url http://localhost:8545

# Check if oracle is paused
cast call $REWARD_CALCULATOR_ADDRESS "isOraclePaused()" --rpc-url http://localhost:8545

# Get threshold score
cast call $REWARD_CALCULATOR_ADDRESS "delegateeEligibilityThresholdScore()" --rpc-url http://localhost:8545
```

## Contract Addresses

The test environment uses the following contracts:

- **Staker Contract**: The main staker contract that handles deposits and rewards
- **Calculator Contract**: Determines delegatee eligibility based on scores
- **Test Token**: An ERC20 token used for testing deposits

The addresses are stored in the `.env.test` file after setup.
