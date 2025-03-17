#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Setting up test environment for Arbitrum...${NC}"

# Check if Forge is installed
if ! command -v forge &> /dev/null; then
    echo -e "${RED}Error: Forge is not installed. Please install Foundry:${NC}"
    echo "curl -L https://foundry.paradigm.xyz | bash"
    exit 1
fi

# Default to Arbitrum Sepolia if not specified
NETWORK=${NETWORK:-arbitrum-sepolia}
echo -e "${YELLOW}Using network: ${NETWORK}${NC}"

# Set RPC URL based on network
case "$NETWORK" in
    "arbitrum-sepolia")
        RPC_URL=${ARB_SEPOLIA_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}
        CHAIN_ID=421614
        ;;
    "arbitrum-goerli")
        RPC_URL=${ARB_GOERLI_RPC_URL:-https://goerli-rollup.arbitrum.io/rpc}
        CHAIN_ID=421613
        ;;
    "arbitrum-one")
        RPC_URL=${ARB_ONE_RPC_URL:-https://arb1.arbitrum.io/rpc}
        CHAIN_ID=42161
        ;;
    "anvil")
        # Use local Anvil node for testing
        RPC_URL="http://localhost:8545"
        CHAIN_ID=31337

        # Start local node if not already running
        if ! nc -z localhost 8545 &>/dev/null; then
            echo -e "${YELLOW}Starting local Anvil node...${NC}"
            anvil --silent &
            ANVIL_PID=$!

            # Wait for node to start
            sleep 2

            echo -e "${YELLOW}Anvil node started with PID: ${ANVIL_PID}${NC}"
            echo $ANVIL_PID > ../../anvil.pid
        else
            echo -e "${YELLOW}Anvil node already running on port 8545${NC}"
        fi
        ;;
    *)
        echo -e "${RED}Error: Unsupported network: ${NETWORK}${NC}"
        echo "Supported networks: arbitrum-sepolia, arbitrum-goerli, arbitrum-one, anvil"
        exit 1
        ;;
esac

echo -e "${YELLOW}Using RPC URL: ${RPC_URL}${NC}"

# Navigate to the arbstaker directory
cd contracts/arbstaker

# Make sure the submodule is initialized and up to date
echo -e "${YELLOW}Initializing arbstaker submodule...${NC}"
git submodule update --init --recursive

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
forge install

# Set up default private keys for testing
# If using a real network, DEPLOYER_KEY must be set in the environment
if [ "$NETWORK" == "anvil" ]; then
    # Default Anvil private keys
    DEPLOYER_KEY=${DEPLOYER_KEY:-"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"}
    ORACLE_KEY=${ORACLE_KEY:-"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"}
    USER_KEY=${USER_KEY:-"0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"}
    EXECUTOR_KEY=${EXECUTOR_KEY:-"0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"}
else
    # For real networks, require private keys
    if [ -z "$DEPLOYER_KEY" ]; then
        echo -e "${RED}Error: DEPLOYER_KEY environment variable must be set for network: ${NETWORK}${NC}"
        exit 1
    fi
    ORACLE_KEY=${ORACLE_KEY:-$DEPLOYER_KEY}
    USER_KEY=${USER_KEY:-$DEPLOYER_KEY}
    EXECUTOR_KEY=${EXECUTOR_KEY:-$DEPLOYER_KEY}
fi

# Deploy test contracts
echo -e "${YELLOW}Deploying test contracts to ${NETWORK}...${NC}"
forge script script/ArbitrumOneTestDeploy.s.sol \
    --broadcast \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_KEY" \
    --chain-id "$CHAIN_ID" \
    -vvv

# Get deployed contract addresses from the broadcast artifacts
BROADCAST_DIR=$(ls -td "broadcast/ArbitrumOneTestDeploy.s.sol"/* | head -1)
LATEST_RUN_JSON="$BROADCAST_DIR/run-latest.json"

if [ ! -f "$LATEST_RUN_JSON" ]; then
    echo -e "${RED}Error: Could not find deployment artifacts at $LATEST_RUN_JSON${NC}"
    exit 1
fi

echo -e "${YELLOW}Extracting contract addresses from deployment...${NC}"
cat "$LATEST_RUN_JSON"

# Extract addresses from the deployment artifacts
# Updated extraction to look at created contracts instead of transactions
STAKER_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.receipts | map(select(.contractName == "ArbStaker")) | .[0].contractAddress')
CALCULATOR_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.receipts | map(select(.contractName == "BinaryEligibilityOracleEarningPowerCalculator")) | .[0].contractAddress')
TOKEN_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.receipts | map(select(.contractName == "ArbTestToken")) | .[0].contractAddress')

# Alternative extraction method if the above doesn't work
if [[ -z "$STAKER_ADDRESS" || -z "$CALCULATOR_ADDRESS" || -z "$TOKEN_ADDRESS" ]]; then
    echo -e "${YELLOW}Trying alternative extraction method...${NC}"
    STAKER_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.transactions[] | select(.contractName == "ArbStaker") | .contractAddress')
    CALCULATOR_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.transactions[] | select(.contractName == "BinaryEligibilityOracleEarningPowerCalculator") | .contractAddress')
    TOKEN_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.transactions[] | select(.contractName == "ArbTestToken") | .contractAddress')
fi

# One more attempt with a broader match
if [[ -z "$STAKER_ADDRESS" || -z "$CALCULATOR_ADDRESS" || -z "$TOKEN_ADDRESS" ]]; then
    echo -e "${YELLOW}Trying broader extraction method...${NC}"
    STAKER_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.transactions[] | select(.contractName | contains("Staker")) | .contractAddress' | head -1)
    CALCULATOR_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.transactions[] | select(.contractName | contains("Calculator")) | .contractAddress' | head -1)
    TOKEN_ADDRESS=$(cat $LATEST_RUN_JSON | jq -r '.transactions[] | select(.contractName | contains("Token")) | .contractAddress' | head -1)
fi

if [[ -z "$STAKER_ADDRESS" || -z "$CALCULATOR_ADDRESS" || -z "$TOKEN_ADDRESS" ]]; then
    echo -e "${RED}Error: Failed to extract all contract addresses${NC}"
    echo "STAKER_ADDRESS: $STAKER_ADDRESS"
    echo "CALCULATOR_ADDRESS: $CALCULATOR_ADDRESS"
    echo "TOKEN_ADDRESS: $TOKEN_ADDRESS"
    exit 1
fi

echo -e "${GREEN}Deployed contracts:${NC}"
echo "STAKER_ADDRESS: $STAKER_ADDRESS"
echo "CALCULATOR_ADDRESS: $CALCULATOR_ADDRESS"
echo "TOKEN_ADDRESS: $TOKEN_ADDRESS"

# Return to the root directory
cd ../..

# Create .env.test file based on the original .env format
echo -e "${GREEN}Creating .env.test file...${NC}"

# First, try to load the format from .env if it exists
if [ -f ".env" ]; then
    echo -e "${YELLOW}Using .env as template for .env.test${NC}"
    # Create a copy of .env as the basis
    cp .env .env.test

    # Update the specific values for the test environment
    # Using sed to replace values while preserving the file structure
    sed -i.bak "s|^RPC_URL=.*|RPC_URL=$RPC_URL|g" .env.test
    sed -i.bak "s|^CHAIN_ID=.*|CHAIN_ID=$CHAIN_ID|g" .env.test
    sed -i.bak "s|^STAKER_ADDRESS=.*|STAKER_ADDRESS=$STAKER_ADDRESS|g" .env.test
    sed -i.bak "s|^REWARD_CALCULATOR_ADDRESS=.*|REWARD_CALCULATOR_ADDRESS=$CALCULATOR_ADDRESS|g" .env.test
    sed -i.bak "s|^STAKE_TOKEN_ADDRESS=.*|STAKE_TOKEN_ADDRESS=$TOKEN_ADDRESS|g" .env.test
    sed -i.bak "s|^ORACLE_PRIVATE_KEY=.*|ORACLE_PRIVATE_KEY=$ORACLE_KEY|g" .env.test
    sed -i.bak "s|^EXECUTOR_PRIVATE_KEY=.*|EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY|g" .env.test
    sed -i.bak "s|^DB_PATH=.*|DB_PATH=./test-staker-monitor-db.json|g" .env.test
    sed -i.bak "s|^COMPONENTS=.*|COMPONENTS=monitor,calculator,profitability|g" .env.test

    # Add any missing essential config if not present
    if ! grep -q "^DB_TYPE=" .env.test; then
        echo "DB_TYPE=json" >> .env.test
    fi

    if ! grep -q "^MIN_PROFIT_MARGIN=" .env.test; then
        echo "MIN_PROFIT_MARGIN=0.0001" >> .env.test
    fi

    if ! grep -q "^GAS_PRICE_BUFFER=" .env.test; then
        echo "GAS_PRICE_BUFFER=20" >> .env.test
    fi

    if ! grep -q "^MAX_BATCH_SIZE=" .env.test; then
        echo "MAX_BATCH_SIZE=10" >> .env.test
    fi

    # Remove backup file
    rm -f .env.test.bak
else
    # If no .env exists, create a new .env.test from scratch
    echo -e "${YELLOW}Creating new .env.test from scratch${NC}"
    cat > .env.test << EOL
# RPC Connection
RPC_URL=$RPC_URL
CHAIN_ID=$CHAIN_ID

# Contract Addresses
STAKER_ADDRESS=$STAKER_ADDRESS
REWARD_CALCULATOR_ADDRESS=$CALCULATOR_ADDRESS
STAKE_TOKEN_ADDRESS=$TOKEN_ADDRESS

# Test Private Keys
ORACLE_PRIVATE_KEY=$ORACLE_KEY
EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY

# Test Configuration
COMPONENTS=monitor,calculator,profitability
DB_TYPE=json
DB_PATH=./test-staker-monitor-db.json
POLL_INTERVAL=5
MAX_BLOCK_RANGE=1000
CONFIRMATIONS=1
START_BLOCK=0
LOG_LEVEL=info
MIN_PROFIT_MARGIN=0.0001
GAS_PRICE_BUFFER=20
MAX_BATCH_SIZE=10
EOL
fi

# Create initial test database file
echo -e "${GREEN}Creating initial test database file...${NC}"
cat > test-staker-monitor-db.json << EOL
{
  "meta": {
    "last_processed_block": 0,
    "last_update": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  },
  "deposits": [],
  "delegatee_scores": []
}
EOL

# Skip creating test data on real networks unless explicitly requested
if [ "$NETWORK" == "anvil" ] || [ "$CREATE_TEST_DATA" == "true" ]; then
    # Create initial test data with cast
    echo -e "${GREEN}Creating initial test data...${NC}"

    # 1. Fund user account with test tokens
    echo "Funding user account with test tokens..."
    cast send --private-key $DEPLOYER_KEY $TOKEN_ADDRESS "mint(address,uint256)" "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" 100000000000000000000 --rpc-url "$RPC_URL"

    # 2. Set up the calculator with initial delegatee scores
    echo "Setting up initial delegatee scores..."
    cast send --private-key $ORACLE_KEY $CALCULATOR_ADDRESS "updateDelegateeScore(address,uint256)" "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" 80 --rpc-url "$RPC_URL"
    cast send --private-key $ORACLE_KEY $CALCULATOR_ADDRESS "updateDelegateeScore(address,uint256)" "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" 70 --rpc-url "$RPC_URL"
    cast send --private-key $ORACLE_KEY $CALCULATOR_ADDRESS "updateDelegateeScore(address,uint256)" "0x90F79bf6EB2c4f870365E785982E1f101E93b906" 50 --rpc-url "$RPC_URL"

    # 3. Approve tokens and create test deposits
    echo "Approving tokens for the Staker contract..."
    cast send --private-key $USER_KEY $TOKEN_ADDRESS "approve(address,uint256)" $STAKER_ADDRESS 100000000000000000000 --rpc-url "$RPC_URL"

    echo "Creating test deposits..."
    # First deposit - to high score delegatee
    cast send --private-key $USER_KEY $STAKER_ADDRESS "deposit(uint256,address)" 10000000000000000000 "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" --rpc-url "$RPC_URL"
    # Second deposit - to medium score delegatee
    cast send --private-key $USER_KEY $STAKER_ADDRESS "deposit(uint256,address)" 20000000000000000000 "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" --rpc-url "$RPC_URL"
    # Third deposit - to low score delegatee
    cast send --private-key $USER_KEY $STAKER_ADDRESS "deposit(uint256,address)" 15000000000000000000 "0x90F79bf6EB2c4f870365E785982E1f101E93b906" --rpc-url "$RPC_URL"
else
    echo -e "${YELLOW}Skipping test data creation on network: ${NETWORK}${NC}"
    echo -e "${YELLOW}Set CREATE_TEST_DATA=true to force test data creation${NC}"
fi

echo -e "${GREEN}Test environment setup complete!${NC}"
echo -e "${YELLOW}Run your bots with: npm run test:harness${NC}"

if [ "$NETWORK" == "anvil" ]; then
    echo -e "${YELLOW}To stop the Anvil node when done: kill \$(cat anvil.pid)${NC}"
fi

echo -e "${YELLOW}Update delegatee scores: npm run update-score 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 85${NC}"
