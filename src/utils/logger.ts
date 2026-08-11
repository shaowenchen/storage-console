type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const enabledLevel = (process.env.LOG_LEVEL || 'debug').toLowerCase() as LogLevel;
const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(level: LogLevel): boolean {
  return levelOrder[level] >= (levelOrder[enabledLevel] ?? levelOrder.info);
}

function format(
  level: LogLevel,
  scope: string,
  msg: string,
  meta?: Record<string, unknown>,
): string {
  const ts = new Date().toISOString();
  const head = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`;
  if (!meta || Object.keys(meta).length === 0) return head;
  try {
    return `${head} ${JSON.stringify(meta)}`;
  } catch {
    return `${head} <unserializable meta>`;
  }
}

export function createLogger(scope: string) {
  return {
    debug(msg: string, meta?: Record<string, unknown>) {
      if (shouldLog('debug')) console.log(format('debug', scope, msg, meta));
    },
    info(msg: string, meta?: Record<string, unknown>) {
      if (shouldLog('info')) console.log(format('info', scope, msg, meta));
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      if (shouldLog('warn')) console.warn(format('warn', scope, msg, meta));
    },
    error(msg: string, meta?: Record<string, unknown>) {
      if (shouldLog('error')) console.error(format('error', scope, msg, meta));
    },
  };
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function previewText(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
