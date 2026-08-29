import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const transcribeScript = path.join(projectDir, 'transcribe.mjs');
const HOST = '127.0.0.1';
const MAX_AUDIO_BYTES = 1920000;
const MAX_CANCEL_BYTES = 2048;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function createAudioRelay({
  token,
  port = 0,
  ttlMs = 300000,
  maxRequests = 1,
  transcribe = transcribePcm,
  exitOnFinish = false,
  allowIdleClose = false,
  extraJsonRoutes = {},
  resultPayload = (result) => ({ text: result.text }),
  onClose = async () => {},
} = {}) {
  if (Buffer.byteLength(token || '', 'utf8') < 32) {
    throw new Error('token must be at least 32 bytes');
  }
  const unlimitedRequests = maxRequests === Number.POSITIVE_INFINITY;
  if (!unlimitedRequests && (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 5)) {
    throw new Error('maxRequests must be an integer from 1 to 5 or positive infinity');
  }
  const requestLimitLabel = unlimitedRequests ? 'unlimited' : String(maxRequests);

  let acceptedCount = 0;
  let closed = false;
  let active = null;
  let expiryTimer = null;
  let closeHookPromise = null;

  function runCloseHook(reason) {
    if (!closeHookPromise) {
      closeHookPromise = Promise.resolve().then(() => onClose(reason));
    }
    return closeHookPromise;
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      const extraRoute = extraJsonRoutes[request.url];
      if (request.method !== 'POST' || (!['/v1/health', '/v1/transcribe', '/v1/cancel'].includes(request.url) && !extraRoute)) {
        return send(response, 404, { ok: false, error: 'not_found' });
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        return send(response, 401, { ok: false, error: 'unauthorized' });
      }

      if (request.url === '/v1/health') {
        const ready = !closed && (unlimitedRequests || acceptedCount < maxRequests);
        console.log(`HEALTH ready=${ready} accepted=${acceptedCount}/${requestLimitLabel}`);
        return send(response, 200, { ok: true, ready });
      }

      if (extraRoute) {
        if (!contentType(request).startsWith('application/json')) {
          return send(response, 415, { ok: false, error: 'json_required' });
        }
        const input = JSON.parse((await readLimited(request, MAX_CANCEL_BYTES)).toString('utf8'));
        const result = await extraRoute(input);
        return send(response, result?.status ?? 200, result?.payload ?? result);
      }

      if (request.url === '/v1/cancel') {
        if (!contentType(request).startsWith('application/json')) {
          return send(response, 415, { ok: false, error: 'json_required' });
        }
        const body = JSON.parse((await readLimited(request, MAX_CANCEL_BYTES)).toString('utf8'));
        return cancelActive(body, response);
      }

      if (closed || (!unlimitedRequests && acceptedCount >= maxRequests)) {
        return send(response, 409, { ok: false, error: 'batch_complete' });
      }
      if (active) return send(response, 409, { ok: false, error: 'busy' });
      if (contentType(request) !== 'application/octet-stream') {
        return send(response, 415, { ok: false, error: 'pcm_required' });
      }
      const requestId = String(request.headers['x-request-id'] || '');
      if (!REQUEST_ID_PATTERN.test(requestId)) {
        return send(response, 400, { ok: false, error: 'invalid_request_id' });
      }
      if (request.headers['x-audio-format'] !== 'pcm_s16le' ||
          request.headers['x-sample-rate'] !== '16000' ||
          request.headers['x-channels'] !== '1') {
        return send(response, 400, { ok: false, error: 'invalid_audio_format' });
      }

      const pcm = await readLimited(request, MAX_AUDIO_BYTES);
      if (pcm.length === 0 || pcm.length % 2 !== 0) {
        return send(response, 400, { ok: false, error: 'invalid_pcm_length' });
      }

      // Another upload may have completed while this body was still arriving.
      // Re-check the batch gate before reserving the only active slot.
      if (closed || (!unlimitedRequests && acceptedCount >= maxRequests)) {
        return send(response, 409, { ok: false, error: 'batch_complete' });
      }
      if (active) return send(response, 409, { ok: false, error: 'busy' });

      acceptedCount += 1;
      const controller = new AbortController();
      active = { requestId, controller, response, finished: false, cancelled: false };
      response.once('finish', () => { if (active?.requestId === requestId) active.finished = true; });
      response.once('close', () => {
        if (!active || active.requestId !== requestId || active.finished || active.cancelled) return;
        controller.abort();
      });

      console.log(`ACCEPTED requestId=${requestId} bytes=${pcm.length} count=${acceptedCount}/${requestLimitLabel}`);
      try {
        const result = await transcribe(pcm, { signal: controller.signal });
        if (!active || active.requestId !== requestId || active.cancelled || response.destroyed) return;
        console.log(`SUCCESS requestId=${requestId} elapsedMs=${result.elapsedMs}`);
        send(response, 200, { ok: true, requestId, ...resultPayload(result) });
        if (!unlimitedRequests && acceptedCount >= maxRequests) {
          if (!unlimitedRequests) {
            closed = true;
            finishServer('batch_complete');
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          if (!response.destroyed && !response.writableEnded) {
            send(response, 409, { ok: false, requestId, error: 'cancelled' });
          }
        } else {
          console.error(`TRANSCRIBE_FAILED requestId=${requestId} error=${error.message}`);
          send(response, 500, { ok: false, requestId, error: 'transcription_failed' });
          closed = true;
          finishServer('processing_failed');
        }
      } finally {
        if (active?.requestId === requestId) active = null;
      }
    } catch (error) {
      const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
      send(response, status, { ok: false, error: status === 413 ? 'body_too_large' : 'invalid_request' });
    }
  });

  server.requestTimeout = 60000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;

  function cancelActive(body, response) {
    if (!body || Object.keys(body).length !== 1 || !REQUEST_ID_PATTERN.test(body.requestId || '')) {
      return send(response, 400, { ok: false, error: 'invalid_cancel_schema' });
    }
    if (!active) {
      if (allowIdleClose && !closed) {
        closed = true;
        console.log(`CLOSED_IDLE requestId=${body.requestId} accepted=${acceptedCount}`);
        send(response, 200, { ok: true, requestId: body.requestId, cancelled: true, idle: true });
        finishServer('idle_closed');
        return;
      }
      return send(response, 409, { ok: false, error: 'no_active_request' });
    }
    if (active.requestId !== body.requestId) {
      return send(response, 409, { ok: false, error: 'request_mismatch' });
    }
    active.cancelled = true;
    closed = true;
    active.controller.abort();
    console.log(`CANCELLED requestId=${body.requestId}`);
    if (!active.response.destroyed && !active.response.writableEnded) {
      send(active.response, 409, { ok: false, requestId: body.requestId, error: 'cancelled' });
    }
    send(response, 200, { ok: true, requestId: body.requestId, cancelled: true });
    finishServer('cancelled');
  }

  async function finishServer(reason) {
    if (!exitOnFinish) return;
    try {
      await runCloseHook(reason);
    } catch (error) {
      console.error(`CLOSE_FAILED reason=${reason} error=${error.message}`);
      process.exitCode = 1;
    }
    server.close(() => process.exit(process.exitCode || 0));
  }

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, resolve);
      });
      expiryTimer = setTimeout(() => {
        console.log('EXPIRED without request');
        void (async () => {
          try {
            await runCloseHook('expired');
          } catch (error) {
            console.error(`CLOSE_FAILED reason=expired error=${error.message}`);
          }
          server.close(() => { if (exitOnFinish) process.exit(3); });
        })();
      }, ttlMs);
      expiryTimer.unref();
      const address = server.address();
      return { host: HOST, port: address.port };
    },
    async close() {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (active) active.controller.abort();
      let closeError = null;
      try {
        await runCloseHook('manual');
      } catch (error) {
        closeError = error;
      }
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      if (closeError) throw closeError;
    },
  };
}

export async function transcribePcm(pcm, { signal } = {}) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'rokid-transcribe-'));
  const wavPath = path.join(workDir, 'input.wav');
  try {
    await writeFile(wavPath, wavFromPcm(pcm));
    const child = spawn(process.execPath, [transcribeScript, '--input', wavPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw new Error('cancelled');
    if (code !== 0) throw new Error(stderr.trim() || `transcriber exited ${code}`);
    return JSON.parse(stdout);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function wavFromPcm(pcm) {
  const data = Buffer.from(pcm);
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

function tokenMatches(authorization, token) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function contentType(request) {
  return String(request.headers['content-type'] || '').toLowerCase().split(';', 1)[0];
}

async function readLimited(request, maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.ROKID_AUDIO_RELAY_TOKEN || '';
  const port = Number(process.env.ROKID_AUDIO_RELAY_PORT || 18444);
  const ttlMs = Number(process.env.ROKID_AUDIO_RELAY_TTL_MS || 300000);
  const maxRequests = Number(process.env.ROKID_AUDIO_RELAY_MAX_REQUESTS || 1);
  try {
    const relay = createAudioRelay({ token, port, ttlMs, maxRequests, exitOnFinish: true });
    const address = await relay.listen();
    console.log(`READY http://${address.host}:${address.port}/v1/transcribe ttlMs=${ttlMs} maxRequests=${maxRequests}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
