import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sanitizedEnvironment } from '../knowledge-router/knowledge-pipeline.mjs';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXED_DAILY_ORIGIN = 'https://personal-ai.example.com';
export const DEFAULT_DAILY_PORT = 18448;
export const DEFAULT_DAILY_TTL_MS = 300_000;
const DEFAULT_CLOUDFLARED = '/opt/homebrew/bin/cloudflared';
const DEFAULT_CONFIG = path.join(homedir(), '.cloudflared', 'rokid-personal-ai.yml');

function validateFixedOptions({ origin, port, ttlMs, configPath, cloudflaredPath }) {
  if (origin !== FIXED_DAILY_ORIGIN) throw new Error('daily origin must use the fixed private hostname');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid daily port');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600_000) throw new Error('invalid daily ttl');
  if (!configPath || !cloudflaredPath) throw new Error('fixed tunnel paths are required');
}

function sessionEnvironment(token, port, ttlMs, source = process.env) {
  return {
    ...sanitizedEnvironment(source),
    ROKID_DAILY_SESSION_TOKEN: token,
    ROKID_DAILY_SESSION_PORT: String(port),
    ROKID_DAILY_SESSION_TTL_MS: String(ttlMs),
  };
}

export function createFixedDailySessionController(options = {}) {
  const origin = options.origin ?? FIXED_DAILY_ORIGIN;
  const port = options.port ?? DEFAULT_DAILY_PORT;
  const ttlMs = options.ttlMs ?? DEFAULT_DAILY_TTL_MS;
  const configPath = options.configPath ?? process.env.ROKID_CLOUDFLARED_CONFIG ?? DEFAULT_CONFIG;
  const cloudflaredPath = options.cloudflaredPath ?? DEFAULT_CLOUDFLARED;
  const tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('hex'));
  const startReceiver = options.startReceiver ?? startReceiverProcess;
  const receiverScript = options.receiverScript ?? path.join(PROJECT_DIR, 'session-receiver.mjs');
  const startTunnel = options.startTunnel ?? startTunnelProcess;
  const checkPublicHealth = options.checkPublicHealth ?? publicHealth;
  const pathExists = options.pathExists ?? existsSync;
  const now = options.now ?? Date.now;
  validateFixedOptions({ origin, port, ttlMs, configPath, cloudflaredPath });

  let receiver = null;
  let tunnel = null;
  let stopping = null;
  let started = false;

  async function stop(reason = 'requested') {
    if (stopping) return stopping;
    stopping = (async () => {
      const results = await Promise.allSettled([
        tunnel?.stop?.(),
        receiver?.stop?.(),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw new Error(`daily session cleanup failed: ${reason}`);
      return { stopped: true, reason };
    })();
    return stopping;
  }

  async function start() {
    if (started) throw new Error('daily session controller is one-shot');
    started = true;
    if (!pathExists(configPath)) throw new Error('Cloudflare tunnel config not found');
    if (!pathExists(cloudflaredPath)) throw new Error('cloudflared executable not found');

    const token = tokenFactory();
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32) {
      throw new Error('daily session token must be at least 32 bytes');
    }
    const receiverEnvironment = sessionEnvironment(token, port, ttlMs, options.environment);
    const tunnelEnvironment = sanitizedEnvironment(options.environment ?? process.env);

    try {
      receiver = await startReceiver({ port, ttlMs, environment: receiverEnvironment, receiverScript });
      tunnel = await startTunnel({
        cloudflaredPath,
        configPath,
        environment: tunnelEnvironment,
      });
      const health = await waitForPublicHealth({
        origin,
        token,
        tunnel,
        checkPublicHealth,
        timeoutMs: options.healthTimeoutMs ?? 55_000,
        retryMs: options.healthRetryMs ?? 500,
      });

      const completion = receiver.completion.then(
        async (result) => {
          await stop('receiver_finished');
          return result;
        },
        async (error) => {
          await stop('receiver_failed');
          throw error;
        },
      );
      completion.catch(() => {});

      return {
        origin,
        token,
        port,
        expiresAt: now() + ttlMs,
        health,
        completion,
        stop,
      };
    } catch (error) {
      await stop('startup_failed').catch(() => {});
      throw error;
    }
  }

  return { start, stop };
}

async function waitForPublicHealth({
  origin,
  token,
  tunnel,
  checkPublicHealth,
  timeoutMs,
  retryMs,
}) {
  const startedAt = Date.now();
  let attempts = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (tunnel.completionStatus?.()) throw new Error('Cloudflare tunnel exited before ready');
    attempts += 1;
    try {
      const result = await checkPublicHealth(origin, token);
      if (result.status === 200 && result.payload?.ok === true && result.payload?.ready === true) {
        return { attempts, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // The fixed edge can take a few seconds to register after startup.
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  throw new Error('Cloudflare fixed daily health check failed');
}

async function startReceiverProcess({ port, ttlMs, environment, receiverScript }) {
  return startManagedProcess({
    command: process.execPath,
    args: [receiverScript],
    cwd: PROJECT_DIR,
    environment,
    readyPattern: /READY http:\/\/127\.0\.0\.1:\d+\/v1\/(?:route|answer)/,
    readyTimeoutMs: 5000,
    label: 'daily receiver',
  });
}

async function startTunnelProcess({ cloudflaredPath, configPath, environment }) {
  return startManagedProcess({
    command: cloudflaredPath,
    args: ['tunnel', '--no-autoupdate', '--config', configPath, 'run'],
    cwd: PROJECT_DIR,
    environment,
    readyPattern: null,
    readyTimeoutMs: 0,
    label: 'Cloudflare tunnel',
  });
}

async function startManagedProcess({
  command,
  args,
  cwd,
  environment,
  readyPattern,
  readyTimeoutMs,
  label,
}) {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let closed = false;
  const append = (chunk) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-16_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  completion.catch(() => {});

  if (readyPattern) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${label} did not become ready`)), readyTimeoutMs);
      const inspect = () => { if (readyPattern.test(output)) finish(); };
      const exited = () => finish(new Error(`${label} exited before ready`));
      const finish = (error) => {
        clearTimeout(timer);
        child.stdout.off('data', inspect);
        child.stderr.off('data', inspect);
        child.off('close', exited);
        if (error) reject(error);
        else resolve();
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('close', exited);
      inspect();
    });
  }

  return {
    completion,
    completionStatus: () => closed,
    async stop() {
      if (closed) return;
      child.kill('SIGTERM');
      const result = await Promise.race([
        completion,
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (result === null && !closed) {
        child.kill('SIGKILL');
        await completion;
      }
    },
  };
}

export async function publicHealth(origin, token) {
  const hostname = new URL(origin).hostname;
  const addresses = await resolve4(hostname);
  if (!addresses.length) throw new Error('fixed daily hostname did not resolve');
  let lastError = null;
  for (const address of addresses) {
    try {
      return await new Promise((resolve, reject) => {
        const request = https.request({
          hostname,
          servername: hostname,
          port: 443,
          path: '/v1/health',
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          lookup(_hostname, lookupOptions, callback) {
            if (lookupOptions?.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
          timeout: 3000,
        }, (response) => {
          const chunks = [];
          let total = 0;
          response.on('data', (chunk) => {
            total += chunk.length;
            if (total > 4096) request.destroy(new Error('daily health response too large'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode,
                payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        });
        request.once('timeout', () => request.destroy(new Error('daily health timeout')));
        request.once('error', reject);
        request.end();
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('fixed daily health failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = createFixedDailySessionController();
  const stopForSignal = async () => {
    await controller.stop('signal').catch(() => {});
    process.exit(130);
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  try {
    const session = await controller.start();
    console.log(
      `SESSION_READY transport=cloudflare-named origin=${session.origin} ` +
      `attempts=${session.health.attempts} elapsedMs=${session.health.elapsedMs} ` +
      `expiresAt=${session.expiresAt}`,
    );
    const result = await session.completion;
    console.log(`SESSION_COMPLETE receiverExit=${result.code ?? result.signal}`);
    process.exitCode = result.code === 0 ? 0 : 1;
  } catch (error) {
    console.error(`SESSION_FAILED ${error.message}`);
    await controller.stop('failure').catch(() => {});
    process.exitCode = 2;
  }
}
