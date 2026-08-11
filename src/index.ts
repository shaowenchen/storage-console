import 'dotenv/config';
import { createApp } from './createApp.js';
import { createLogger } from './utils/logger.js';
import { validateProductionConfig, getPort, getHost } from './config/env.js';

const log = createLogger('server');

function start() {
  validateProductionConfig();
  const app = createApp();
  const port = getPort();
  const host = getHost();
  app.listen(port, host, () => {
    log.info('storage-console started', { host, port });
  });
}

start();
