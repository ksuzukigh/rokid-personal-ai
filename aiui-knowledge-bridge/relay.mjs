import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { runKnowledgePipeline } from '../knowledge-router/knowledge-pipeline.mjs';

export const DEFAULT_QUESTION =
  'Rokidを使って私が今まで作ったものと、実機で確かめたことをまとめて';
const FIXED_VAULT = '/path/to/your/ObsidianVault';
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2048;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function createKnowledgeRelay({
  token,
  expectedQuestion = DEFAULT_QUESTION,
  port = 0,
  ttlMs = 300000,
  exitOnFinish = false,
  pipeline = runKnowledgePipeline,
} = {}) {
  if (Buffer.byteLength(token || '', 'utf8') < 32) {
    throw new Error('token must be at least 32 bytes');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600000) throw new Error('invalid ttl');
  expectedQuestion = normalizeSessionQuestion(expectedQuestion);

  let consumed = false;
  let active = null;
  let expiryTimer = null;

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      if (request.method !== 'POST' || !['/v1/health', '/v1/ask', '/v1/cancel'].includes(request.url)) {
        return send(response, 404, { ok: false, error: 'not_found' });
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        return send(response, 401, { ok: false, error: 'unauthorized' });
      }
      if (request.url === '/v1/health') {
        return send(response, 200, { ok: true, ready: !consumed });
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return send(response, 415, { ok: false, error: 'json_required' });
      }

      const body = JSON.parse((await readLimited(request)).toString('utf8'));
      if (request.url === '/v1/cancel') return cancelActive(response, body);
      if (consumed) return send(response, 409, { ok: false, error: 'already_used' });
      if (!validAsk(body, expectedQuestion)) {
        return send(response, 400, { ok: false, error: 'invalid_request' });
      }

      consumed = true;
      const controller = new AbortController();
      const requestId = body.requestId;
      active = { requestId, controller, response, finished: false };
      response.once('finish', () => {
        if (active?.requestId === requestId) active.finished = true;
      });
      response.once('close', () => {
        if (active?.requestId === requestId && !active.finished) controller.abort();
      });
      console.log(`ACCEPTED requestId=${requestId}`);

      try {
        const result = await pipeline({
          vaultPath: FIXED_VAULT,
          question: body.question,
          answerCharacterLimit: 160,
          signal: controller.signal,
          searchLimit: 16,
          perFileLimit: 2,
          transmission: { maximumSources: 6, maximumExcerptCharacters: 4800 },
        });
        if (controller.signal.aborted) throw abortError();
        const sources = result.answer.citations.map(({ sourceId, path, section }) => ({
          sourceId,
          path,
          section,
        }));
        console.log(
          `SUCCESS requestId=${requestId} sources=${result.transmission.sent.length} ` +
            `excerptChars=${result.transmission.totalExcerptCharacters}`,
        );
        send(response, 200, {
          ok: true,
          requestId,
          answer: result.answer.text,
          sources,
        });
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) {
          console.log(`CANCELLED requestId=${requestId}`);
          send(response, 409, { ok: false, requestId, error: 'cancelled' });
        } else {
          console.error(`FAILED requestId=${requestId} error=${safeErrorCode(error)}`);
          send(response, 500, {
            ok: false,
            requestId,
            error: 'processing_failed',
            answer: '回答を作れませんでした。何も変更していません',
          });
        }
      } finally {
        active = null;
        if (exitOnFinish) server.close(() => process.exit(0));
      }
    } catch (error) {
      const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
      send(response, status, { ok: false, error: status === 413 ? 'body_too_large' : 'invalid_json' });
    }
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;

  function cancelActive(response, body) {
    if (!validCancel(body)) return send(response, 400, { ok: false, error: 'invalid_cancel' });
    if (!active) return send(response, 409, { ok: false, error: 'no_active_request' });
    if (active.requestId !== body.requestId) {
      return send(response, 409, { ok: false, error: 'request_mismatch' });
    }
    active.controller.abort();
    return send(response, 200, { ok: true, requestId: body.requestId, cancelled: true });
  }

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
        server.close(() => { if (exitOnFinish) process.exit(3); });
      }, ttlMs);
      expiryTimer.unref();
      const address = server.address();
      return { host: HOST, port: address.port };
    },
    async close() {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (active) active.controller.abort();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function tokenMatches(authorization, token) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function validAsk(body, expectedQuestion) {
  try {
    return body &&
      Object.keys(body).sort().join(',') === 'question,requestId' &&
      REQUEST_ID_PATTERN.test(body.requestId || '') &&
      normalizeSessionQuestion(body.question) === expectedQuestion;
  } catch {
    return false;
  }
}

export function normalizeSessionQuestion(value) {
  const question = String(value ?? '').normalize('NFKC').trim();
  if (!question || question.length > 240) throw new Error('question must be 1 to 240 characters');
  if (/[\u0000-\u001f\u007f]/u.test(question)) throw new Error('question contains control characters');
  return question;
}

function validCancel(body) {
  return body &&
    Object.keys(body).join(',') === 'requestId' &&
    REQUEST_ID_PATTERN.test(body.requestId || '');
}

async function readLimited(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(response, status, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.end(JSON.stringify(payload));
}

function abortError() {
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

function safeErrorCode(error) {
  return String(error?.message || 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.ROKID_KNOWLEDGE_TOKEN || '';
  const expectedQuestion = process.env.ROKID_KNOWLEDGE_QUESTION || DEFAULT_QUESTION;
  const port = Number(process.env.ROKID_KNOWLEDGE_PORT || 18448);
  const ttlMs = Number(process.env.ROKID_KNOWLEDGE_TTL_MS || 300000);
  try {
    const relay = createKnowledgeRelay({ token, expectedQuestion, port, ttlMs, exitOnFinish: true });
    const address = await relay.listen();
    console.log(`READY http://${address.host}:${address.port}/v1/ask ttlMs=${ttlMs}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
