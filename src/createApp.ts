import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { apiErrorBody, INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from './domain/apiError.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import authRouter from './routes/auth.js';
import storageRouter from './routes/storage.js';
import { jsonBodyParser } from './middleware/jsonBodyParser.js';
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

  // Allow text object PUT bodies up to ~1MB content plus JSON wrapper.
  // Raw object uploads pass through untouched so the upload route can stream them.
  app.use(jsonBodyParser());

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
    // A body-parser rejection is the request's fault, not the server's, and it
    // carries its own status. Reporting it as an opaque 500 would also matter
    // beyond the wrong number: the upload client treats a status without an
    // explicit verdict as retryable, so a body the server will never accept
    // would be re-sent until the retry budget ran out.
    const parserStatus = (err as { status?: unknown })?.status;
    const parserType = (err as { type?: unknown })?.type;
    if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
      log.warn('Rejected request body', {
        method: req.method,
        path: req.originalUrl,
        type: typeof parserType === 'string' ? parserType : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      res
        .status(parserStatus)
        .json(apiErrorBody(err instanceof Error ? err.message : 'Invalid request body'));
      return;
    }

    log.error('Unhandled error', {
      method: req.method,
      path: req.originalUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(apiErrorBody(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE));
  });

  return app;
}
