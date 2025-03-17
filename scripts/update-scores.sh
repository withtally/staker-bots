#!/bin/bash
set -e

# Use the ArbitrumOneTestDeploy script for score updates
cd contracts/arbstaker

# Get the calculator address from .env.test
CALCULATOR_ADDRESS=$(grep REWARD_CALCULATOR_ADDRESS ../../.env.test | cut -d '=' -f2)

# Update scores using cast (Foundry's command-line tool)
ORACLE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DELEGATEE="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
SCORE=$1
echo "Updating score for ${DELEGATEE} to ${SCORE}"
cast send --private-key ${ORACLE_KEY} ${CALCULATOR_ADDRESS} "updateDelegateeScore(address,uint256)" ${DELEGATEE} ${SCORE} --rpc-url http://localhost:8545
