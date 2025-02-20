import { ExecutorConfig } from './interfaces/types';
import { ethers } from 'ethers';

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  wallet: {
    privateKey: '',
    minBalance: ethers.parseEther('0.1'), // 0.1 ETH
    maxPendingTransactions: 5,
  },
  maxQueueSize: 100,
  minConfirmations: 2,
  maxRetries: 3,
  retryDelayMs: 5000,
  transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
  gasBoostPercentage: 10, // 10%
  concurrentTransactions: 3,
};
