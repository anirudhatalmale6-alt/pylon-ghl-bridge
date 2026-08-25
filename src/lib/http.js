import { httpError, networkError } from './errors.js';
import { logger } from './logger.js';

/**
 * One place where every outbound HTTP call goes, so that timeouts, error
 * classification and logging behave identically for Pylon and GoHighLevel.
 */
export async function requestJson({
  system,
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs = 20000,
  expectBinary = false,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw networkError(system, url, error);
  }
  clearTimeout(timer);

  const durationMs = Date.now() - started;

  if (!response.ok) {
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '<unreadable body>';
    }
    logger.warn('upstream request failed', { system, method, url, status: response.status, durationMs });
    throw httpError(system, method, url, response.status, text);
  }

  logger.debug('upstream request ok', { system, method, url, status: response.status, durationMs });

  if (expectBinary) {
    return {
      status: response.status,
      headers: response.headers,
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  }

  if (response.status === 204) return { status: 204, headers: response.headers, data: null };

  const text = await response.text();
  if (!text) return { status: response.status, headers: response.headers, data: null };
  try {
    return { status: response.status, headers: response.headers, data: JSON.parse(text) };
  } catch {
    return { status: response.status, headers: response.headers, data: text };
  }
}

export function buildUrl(base, pathname, query = {}) {
  const url = new URL(pathname.replace(/^\//, ''), `${base.replace(/\/$/, '')}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
