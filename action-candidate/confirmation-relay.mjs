import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

function secretMatches(expected, supplied) {
  const left = createHash('sha256').update(String(expected)).digest();
  const right = createHash('sha256').update(String(supplied ?? '')).digest();
  return timingSafeEqual(left, right);
}

function send(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store',
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2048) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
  return value;
}

export function createConfirmationRelay({ store, bearer, onDecision = () => {} }) {
  if (!store || typeof store.confirm !== 'function' || typeof store.cancel !== 'function') {
    throw new Error('confirmation store is required');
  }
  if (typeof bearer !== 'string' || bearer.length < 32) throw new Error('bearer is too short');
  return http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'method_not_allowed' });
      const authorization = request.headers.authorization ?? '';
      if (!authorization.startsWith('Bearer ') || !secretMatches(bearer, authorization.slice(7))) {
        return send(response, 401, { ok: false, error: 'unauthorized' });
      }
      if (request.url === '/v1/health') return send(response, 200, { ok: true, ready: true });
      if (!['/v1/confirm', '/v1/cancel'].includes(request.url)) {
        return send(response, 404, { ok: false, error: 'not_found' });
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return send(response, 415, { ok: false, error: 'content_type' });
      }
      const input = await readJson(request);
      const allowed = new Set(['ticketId', 'candidateId', 'confirmationToken']);
      if (Object.keys(input).some((key) => !allowed.has(key))) {
        return send(response, 400, { ok: false, error: 'unexpected_field' });
      }
      const result = request.url === '/v1/confirm' ? store.confirm(input) : store.cancel(input);
      if (result.accepted) {
        const decisionResult = await onDecision(result) ?? {};
        send(response, 200, { ok: true, ...result, ...decisionResult });
      } else {
        send(response, result.reason === 'expired' ? 410 : 409, { ok: false, ...result });
      }
    } catch (error) {
      const code = error.message === 'body_too_large' ? 413 : 400;
      send(response, code, { ok: false, error: code === 413 ? 'body_too_large' : 'invalid_request' });
    }
  });
}
