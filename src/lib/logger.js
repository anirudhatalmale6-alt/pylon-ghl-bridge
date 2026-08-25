const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

// Anything matching these key names is redacted before it reaches stdout, so a
// log file can be handed to the client without leaking their API tokens.
const SECRET_KEYS = /(token|secret|authorization|apikey|api_key|password|signature)/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, message, context) {
  if (LEVELS[level] > threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ? { context: redact(context) } : {}),
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  error: (message, context) => emit('error', message, context),
  warn: (message, context) => emit('warn', message, context),
  info: (message, context) => emit('info', message, context),
  debug: (message, context) => emit('debug', message, context),
  redact,
};
