import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { apiErrorBody, INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from './domain/apiError.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import authRouter from './routes/auth.js';
import storageRouter from './routes/storage.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('server');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolvePublicDir(): string {
  const candidates = [
    join(__dirname, 'public'),
    join(__dirname, '../dist/public'),
    join(__dirname, '../web/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return join(__dirname, 'public');
}

export function createApp(): Express {
  const publicDir = resolvePublicDir();
  const indexHtmlPath = join(publicDir, 'index.html');
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRouter);
  app.use('/api/storages', storageRouter);

  app.use(
    '/',
    express.static(publicDir, {
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );

  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(readFileSync(indexHtmlPath, 'utf8'));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled error', {
      method: req.method,
      path: req.originalUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(apiErrorBody(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE));
  });

  return app;
}
