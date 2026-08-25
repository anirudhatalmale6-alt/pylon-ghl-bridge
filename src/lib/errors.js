/**
 * Every failure that leaves this service carries a machine-readable `kind` and a
 * sentence a non-developer can act on. Acceptance criterion 3 ("error handling
 * returns a clear message in case Pylon or GoHighLevel is unreachable") is met
 * by classifying here rather than letting raw fetch/TypeError text escape.
 */
export class IntegrationError extends Error {
  constructor(message, { kind = 'unknown', system = 'bridge', status, detail, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'IntegrationError';
    this.kind = kind;
    this.system = system;
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      message: this.message,
      kind: this.kind,
      system: this.system,
      status: this.status,
      detail: this.detail,
      retryable: this.retryable,
    };
  }
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Digs the OS-level code out of a fetch failure. undici wraps the real cause,
 * and when a host resolves to both IPv4 and IPv6 it wraps it twice more inside
 * an AggregateError — so both `cause` and `errors[]` have to be walked or every
 * connection refusal reads as a vague "fetch failed".
 */
function rootCode(error, depth = 0) {
  if (!error || depth > 6) return undefined;
  if (error.code && error.code !== 'ERR_INVALID_STATE') return error.code;
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const found = rootCode(nested, depth + 1);
      if (found) return found;
    }
  }
  return rootCode(error.cause, depth + 1);
}

/** Turns a thrown fetch error into an IntegrationError with a human sentence. */
export function networkError(system, url, error) {
  const code = rootCode(error);
  const host = safeHost(url);
  if (code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return new IntegrationError(
      `${system} did not respond in time (${host}). The request was aborted after the configured timeout.`,
      { kind: 'timeout', system, retryable: true, detail: { url: host, code }, cause: error },
    );
  }
  if (NETWORK_CODES.has(code)) {
    return new IntegrationError(
      `${system} is unreachable (${host}, ${code}). Check that the host is up and that this server has outbound network access.`,
      { kind: 'unreachable', system, retryable: true, detail: { url: host, code }, cause: error },
    );
  }
  return new IntegrationError(
    `Unexpected failure while calling ${system} (${host}): ${error?.message || error}`,
    { kind: 'network', system, retryable: true, detail: { url: host, code }, cause: error },
  );
}

/** Turns a non-2xx HTTP response into an IntegrationError with a human sentence. */
export function httpError(system, method, url, status, bodyText) {
  const host = safeHost(url);
  const detail = { method, url: host, status, body: truncate(bodyText, 1500) };
  if (status === 401 || status === 403) {
    return new IntegrationError(
      `${system} rejected the credentials (HTTP ${status} on ${method} ${host}). The API token is missing, expired, or lacks the required scope.`,
      { kind: 'auth', system, status, detail, retryable: false },
    );
  }
  if (status === 404) {
    return new IntegrationError(
      `${system} could not find the requested record (HTTP 404 on ${method} ${host}).`,
      { kind: 'not_found', system, status, detail, retryable: false },
    );
  }
  if (status === 422 || status === 400) {
    return new IntegrationError(
      `${system} refused the payload as invalid (HTTP ${status} on ${method} ${host}). ${extractMessage(bodyText)}`.trim(),
      { kind: 'validation', system, status, detail, retryable: false },
    );
  }
  if (status === 429) {
    return new IntegrationError(
      `${system} rate limit hit (HTTP 429 on ${method} ${host}). The event will be retried automatically.`,
      { kind: 'rate_limit', system, status, detail, retryable: true },
    );
  }
  if (status >= 500) {
    return new IntegrationError(
      `${system} returned a server error (HTTP ${status} on ${method} ${host}). The event will be retried automatically.`,
      { kind: 'upstream', system, status, detail, retryable: true },
    );
  }
  return new IntegrationError(
    `${system} returned an unexpected HTTP ${status} on ${method} ${host}. ${extractMessage(bodyText)}`.trim(),
    { kind: 'http', system, status, detail, retryable: false },
  );
}

function extractMessage(bodyText) {
  if (!bodyText) return '';
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed.message ?? parsed.error ?? parsed.errors ?? parsed.detail;
    if (!message) return '';
    return typeof message === 'string' ? message : JSON.stringify(message);
  } catch {
    return truncate(bodyText, 300);
  }
}

function truncate(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeHost(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}
