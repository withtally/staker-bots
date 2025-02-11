// Re-export everything from monitor
export * from './monitor';

// Import and run the monitor's main function
import { main } from './monitor';

// Run the monitor
main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
