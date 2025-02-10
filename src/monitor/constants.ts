import { ethers } from 'ethers';
import { MonitorConfig } from './types';
import { IDatabase } from '@/database';
import { CONFIG } from '@/config';

// ABI fragments
export const STAKER_ABI = [
  'event StakeDeposited(string indexed depositId, address indexed ownerAddress, address indexed delegateeAddress, uint256 amount)',
  'event StakeWithdrawn(string indexed depositId)',
  'event DelegateeAltered(string indexed depositId, address indexed oldDelegatee, address indexed newDelegatee)',
];

export const createMonitorConfig = (
  provider: ethers.Provider,
  database: IDatabase,
): MonitorConfig => ({
  provider,
  database,
  networkName: 'arbitrum',
  ...CONFIG.monitor,
});
