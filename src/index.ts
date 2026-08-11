import 'dotenv/config';
import { createApp } from './createApp.js';
import { createLogger } from './utils/logger.js';
import { validateProductionConfig, getPort, getHost } from './config/env.js';
import { bootstrapAppKeys } from './services/appKeyStore.js';

const log = createLogger('server');

async function start() {
  validateProductionConfig();
  await bootstrapAppKeys();
  const app = createApp();
  const port = getPort();
  const host = getHost();
  app.listen(port, host, () => {
    log.info('storage-console started', { host, port });
  });
}

void start().catch((error) => {
  log.error('Failed to start storage-console', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
