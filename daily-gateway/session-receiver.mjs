import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { routeDailyUtterance } from './intent-router.mjs';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2048;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function secretMatches(expected, supplied) {
  const left = createHash('sha256').update(String(expected)).digest();
  const right = createHash('sha256').update(String(supplied ?? '')).digest();
  return timingSafeEqual(left, right);
}

function send(response, status, payload) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
  return value;
}

export function normalizeDailyUtterance(value) {
  const utterance = String(value ?? '').normalize('NFKC').trim();
  if (!utterance || utterance.length > 500) throw new Error('utterance must be 1 to 500 characters');
  if (/[\u0000-\u001f\u007f]/u.test(utterance)) throw new Error('utterance contains control characters');
  return utterance;
}

function validRouteInput(input) {
  if (Object.keys(input).sort().join(',') !== 'requestId,utterance') return null;
  if (!REQUEST_ID_PATTERN.test(input.requestId ?? '')) return null;
  try {
    return { requestId: input.requestId, utterance: normalizeDailyUtterance(input.utterance) };
  } catch {
    return null;
  }
}

function validCancelInput(input) {
  return Object.keys(input).join(',') === 'requestId' && REQUEST_ID_PATTERN.test(input.requestId ?? '');
}

function abortError() {
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

export function createDailySessionReceiver({
  bearer,
  port = 0,
  ttlMs = 300_000,
  exitOnFinish = false,
  router = routeDailyUtterance,
} = {}) {
  if (typeof bearer !== 'string' || Buffer.byteLength(bearer, 'utf8') < 32) {
    throw new Error('bearer must be at least 32 bytes');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600_000) throw new Error('invalid ttl');
  if (typeof router !== 'function') throw new Error('router is required');

  let consumed = false;
  let active = null;
  let expiryTimer = null;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'method_not_allowed' });
      const authorization = request.headers.authorization ?? '';
      if (!authorization.startsWith('Bearer ') || !secretMatches(bearer, authorization.slice(7))) {
        return send(response, 401, { ok: false, error: 'unauthorized' });
      }
      if (request.url === '/v1/health') {
        return send(response, 200, { ok: true, ready: !consumed, active: Boolean(active) });
      }
      if (!['/v1/route', '/v1/cancel'].includes(request.url)) {
        return send(response, 404, { ok: false, error: 'not_found' });
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return send(response, 415, { ok: false, error: 'json_required' });
      }

      const input = await readJson(request);
      if (request.url === '/v1/cancel') {
        if (!validCancelInput(input)) return send(response, 400, { ok: false, error: 'invalid_cancel' });
        if (!active) return send(response, 409, { ok: false, error: 'no_active_request' });
        if (active.requestId !== input.requestId) {
          return send(response, 409, { ok: false, error: 'request_mismatch' });
        }
        active.controller.abort();
        return send(response, 200, { ok: true, requestId: input.requestId, cancelled: true, changed: false });
      }

      if (consumed) return send(response, 409, { ok: false, error: 'already_used', changed: false });
      const normalized = validRouteInput(input);
      if (!normalized) return send(response, 400, { ok: false, error: 'invalid_request', changed: false });

      consumed = true;
      const controller = new AbortController();
      active = { requestId: normalized.requestId, controller, finished: false };
      response.once('finish', () => {
        if (active?.requestId === normalized.requestId) active.finished = true;
      });
      response.once('close', () => {
        if (active?.requestId === normalized.requestId && !active.finished) controller.abort();
      });
      console.log(`ACCEPTED requestId=${normalized.requestId}`);

      try {
        const result = await router({ utterance: normalized.utterance, signal: controller.signal });
        if (controller.signal.aborted) throw abortError();
        console.log(`ROUTED requestId=${normalized.requestId} intent=${result.intent}`);
        send(response, 200, {
          ok: true,
          requestId: normalized.requestId,
          intent: result.intent,
          allowedNextStep: result.allowedNextStep,
          summary: result.summary,
          confirmationRequired: result.confirmationRequired,
          recordingConsentRequired: result.recordingConsentRequired,
          clarifyingQuestion: result.clarifyingQuestion,
          executionCapability: 'none',
          changed: false,
        });
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) {
          console.log(`CANCELLED requestId=${normalized.requestId}`);
          send(response, 409, {
            ok: false,
            requestId: normalized.requestId,
            error: 'cancelled',
            changed: false,
          });
        } else {
          console.error(`FAILED requestId=${normalized.requestId} error=processing_failed`);
          send(response, 500, {
            ok: false,
            requestId: normalized.requestId,
            error: 'processing_failed',
            message: '行き先を決められませんでした。何も変更していません',
            changed: false,
          });
        }
      } finally {
        active = null;
        if (exitOnFinish) {
          await closeHttpServer(server);
          process.exit(0);
        }
      }
    } catch (error) {
      const status = error?.message === 'body_too_large' ? 413 : 400;
      send(response, status, {
        ok: false,
        error: status === 413 ? 'body_too_large' : 'invalid_json',
        changed: false,
      });
    }
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, resolve);
      });
      expiryTimer = setTimeout(() => {
        if (active) active.controller.abort();
        console.log(`EXPIRED consumed=${consumed}`);
        closeHttpServer(server).then(() => { if (exitOnFinish) process.exit(3); });
      }, ttlMs);
      expiryTimer.unref();
      const address = server.address();
      return { host: HOST, port: address.port };
    },
    async close() {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (active) active.controller.abort();
      await closeHttpServer(server);
    },
  };
}

async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    server.close(finish);
    server.closeIdleConnections?.();
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, 250);
    forceTimer.unref();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bearer = process.env.ROKID_DAILY_SESSION_TOKEN ?? '';
  const port = Number(process.env.ROKID_DAILY_SESSION_PORT ?? 18448);
  const ttlMs = Number(process.env.ROKID_DAILY_SESSION_TTL_MS ?? 300_000);
  try {
    const receiver = createDailySessionReceiver({ bearer, port, ttlMs, exitOnFinish: true });
    const address = await receiver.listen();
    console.log(`READY http://${address.host}:${address.port}/v1/route ttlMs=${ttlMs}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
