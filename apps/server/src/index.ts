import 'dotenv/config';
import { startBsaServer } from './main.js';

// Last resort: an error that escapes a handler is logged, never fatal. A crash would drop every
// user's connection to their Flex at once.
process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('[server] uncaught exception:', e));

await startBsaServer();
