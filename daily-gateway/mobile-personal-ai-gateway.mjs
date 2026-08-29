import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const DEFAULT_BOOTSTRAP_PORT = 18447;
const DEFAULT_SESSION_PORT = 18448;
const MAX_BOOTSTRAP_BODY = 1024;
const MAX_AIX_BYTES = 512 * 1024;
const DEFAULT_ORIGIN = 'https://personal-ai.example.com';
const DEFAULT_CLOUDFLARED = '/opt/homebrew/bin/cloudflared';
const DEFAULT_SESSION_SCRIPT = path.join(import.meta.dirname, 'start-mobile-voice-session.mjs');

export function createMobilePersonalAiGateway(options = {}) {
  const output = options.output ?? console.log;
  const errorOutput = options.errorOutput ?? console.error;
  const bootstrapPort = options.bootstrapPort ?? DEFAULT_BOOTSTRAP_PORT;
  const sessionPort = options.sessionPort ?? DEFAULT_SESSION_PORT;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const tokenFile = options.tokenFile ?? path.join(homedir(), '.config/rokid-personal-ai/bootstrap-token');
  const tunnelConfig = options.tunnelConfig ?? path.join(homedir(), '.cloudflared/rokid-personal-ai-mobile.yml');
  const cloudflared = options.cloudflared ?? DEFAULT_CLOUDFLARED;
  const sessionScript = options.sessionScript ?? DEFAULT_SESSION_SCRIPT;
  const spawnProcess = options.spawnProcess ?? spawn;
  const fetchPublic = options.fetchPublic ?? fetch;
  const readSecret = options.readSecret ?? (() => readFile(tokenFile, 'utf8'));
  const createWork = options.createWork ?? (() => mkdtemp(path.join(tmpdir(), 'rokid-personal-ai-mobile-')));
  const removeWork = options.removeWork ?? ((directory) => rm(directory, { recursive: true, force: true }));
  const readAix = options.readAix ?? ((file) => readFile(file));
  const aixStat = options.aixStat ?? ((file) => stat(file));

  validatePort(bootstrapPort, 'bootstrap');
  validatePort(sessionPort, 'session');
  if (origin !== DEFAULT_ORIGIN) throw new Error('mobile gateway requires the fixed private origin');

  let bootstrapToken = '';
  let server = null;
  let tunnel = null;
  let activeSession = null;
  let stopping = false;
  let completionResolve;
  const completion = new Promise((resolve) => { completionResolve = resolve; });

  async function start() {
    bootstrapToken = String(await readSecret()).trim();
    if (Buffer.byteLength(bootstrapToken, 'utf8') < 32) {
      throw new Error('Personal AI bootstrap token is missing');
    }
    server = http.createServer(handleRequest);
    server.requestTimeout = 15000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(bootstrapPort, HOST, resolve);
    });
    startTunnel();
    output(`PERSONAL_AI_MOBILE_WAITING origin=${origin} changed=false`);
    return { completion, origin, recordingStarted: false, changed: false };
  }

  async function handleRequest(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (request.method !== 'POST' || !['/v1/bootstrap', '/v1/status', '/v1/end'].includes(request.url)) {
        return sendJson(response, 404, { ok: false, error: 'not_found' });
      }
      if (!secretMatches(bootstrapToken, request.headers.authorization)) {
        return sendJson(response, 401, { ok: false, error: 'unauthorized' });
      }
      await readLimited(request, MAX_BOOTSTRAP_BODY);
      if (request.url === '/v1/status') {
        return sendJson(response, 200, { ok: true, active: activeSession !== null });
      }
      if (request.url === '/v1/end') {
        await stopActiveSession('device_closed');
        return sendJson(response, 200, { ok: true, closed: true });
      }
      await stopActiveSession('reopened');
      const session = await startSession();
      activeSession = session;
      await waitForPublicHealth(session.token);
      const info = await aixStat(session.aixPath);
      if (!info.isFile() || info.size < 1 || info.size > MAX_AIX_BYTES) {
        throw new Error('mobile AIX size is invalid');
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/vnd.rokid.aix');
      response.setHeader('Content-Length', String(info.size));
      createReadStream(session.aixPath).pipe(response);
      output('PERSONAL_AI_MOBILE_SESSION_READY recordingStarted=false changed=false');
    } catch (error) {
      errorOutput(`PERSONAL_AI_MOBILE_START_FAILED ${error.message}`);
      await stopActiveSession('start_failed');
      sendJson(response, 503, { ok: false, error: 'temporarily_unavailable' });
    }
  }

  async function startSession() {
    const workDirectory = await createWork();
    const aixPath = path.join(workDirectory, 'personal-ai.aix');
    const token = randomBytes(32).toString('hex');
    const child = spawnProcess(process.execPath, [sessionScript, aixPath], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        ROKID_VOICE_KNOWLEDGE_TOKEN: token,
        ROKID_VOICE_KNOWLEDGE_PORT: String(sessionPort),
        ROKID_VOICE_KNOWLEDGE_TTL_MS: '900000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const session = { child, token, workDirectory, aixPath, completion: null };
    session.completion = watchSession(child, output, errorOutput, () => {
      if (activeSession === session) void stopActiveSession('device_closed');
    }).finally(async () => {
      await removeWork(workDirectory).catch(() => {});
      if (activeSession === session) activeSession = null;
    });
    try {
      await waitForSessionReady(child, 15000);
      const bytes = await readAix(aixPath);
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_AIX_BYTES) {
        throw new Error('mobile AIX was not prepared');
      }
      return session;
    } catch (error) {
      child.kill('SIGTERM');
      await session.completion.catch(() => {});
      throw error;
    }
  }

  async function waitForPublicHealth(sessionToken) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetchPublic(`${origin}/v1/health`, {
          method: 'POST',
          headers: { authorization: `Bearer ${sessionToken}` },
          signal: controller.signal,
        });
        const body = await response.json();
        if (response.ok && body?.ok === true && body?.ready === true) return;
      } catch {
        // The persistent tunnel reconnects on its own; retry during its short warm-up.
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('mobile route did not become publicly reachable');
  }

  function startTunnel() {
    if (stopping || tunnel) return;
    tunnel = spawnProcess(
      cloudflared,
      ['tunnel', '--no-autoupdate', '--config', tunnelConfig, 'run'],
      { cwd: import.meta.dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    tunnel.stdout?.resume?.();
    tunnel.stderr?.resume?.();
    tunnel.once('error', (error) => {
      errorOutput(`PERSONAL_AI_TUNNEL_FAILED ${error.message}`);
    });
    tunnel.once('close', (code) => {
      tunnel = null;
      if (stopping) return;
      errorOutput(`PERSONAL_AI_TUNNEL_RESTART code=${code}`);
      setTimeout(startTunnel, 5000);
    });
  }

  async function stopActiveSession(reason) {
    const session = activeSession;
    activeSession = null;
    if (!session) return;
    if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill('SIGTERM');
    let timer = null;
    const exited = await Promise.race([
      session.completion.then(() => true, () => true).finally(() => { if (timer) clearTimeout(timer); }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exited && session.child.exitCode === null) {
      session.child.kill('SIGKILL');
      await session.completion.catch(() => {});
    }
    await removeWork(session.workDirectory).catch(() => {});
    output(`PERSONAL_AI_MOBILE_SESSION_STOPPED reason=${reason}`);
  }

  async function stop() {
    if (stopping) return completion;
    stopping = true;
    await stopActiveSession('mac_service_stopped');
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill('SIGTERM');
    tunnel = null;
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    completionResolve({ stopped: true });
    return completion;
  }

  return { start, stop };
}

function waitForSessionReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => finish(new Error('mobile session did not become ready')), timeoutMs);
    const onStdout = (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64 * 1024);
      if (/^SESSION_READY\b/m.test(stdout)) finish();
    };
    const onStderr = (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); };
    const onClose = (code) => finish(new Error(stderr.trim() || `mobile session exited before ready: ${code}`));
    const onError = (error) => finish(error);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('close', onClose);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

function watchSession(child, output, errorOutput, onIdleClose = () => {}) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (/^(ACCEPTED|SUCCESS|TRANSCRIBE_FAILED|CLOSED_IDLE)\b/.test(line)) {
        output(`PERSONAL_AI_SESSION ${line}`);
        if (/^CLOSED_IDLE\b/.test(line)) onIdleClose();
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 && code !== 130 && stderr.trim()) {
        errorOutput(`PERSONAL_AI_SESSION_ENDED ${stderr.trim().split(/\r?\n/).at(-1)}`);
      }
      resolve({ code, signal });
    });
  });
}

function secretMatches(expected, authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readLimited(request, maximum) {
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) throw new Error('bootstrap request is too large');
  }
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function validatePort(value, label) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`invalid ${label} port`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gateway = createMobilePersonalAiGateway();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gateway.stop().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const running = await gateway.start();
    await running.completion;
  } catch (error) {
    console.error(`PERSONAL_AI_MOBILE_FAILED ${error.message}`);
    process.exitCode = 2;
  }
}
