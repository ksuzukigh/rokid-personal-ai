import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const [outputAixArgument] = process.argv.slice(2);
const cloudflared = '/opt/homebrew/bin/cloudflared';
const origin = 'https://personal-ai.example.com';
const config = process.env.ROKID_CLOUDFLARED_CONFIG ||
  resolve(homedir(), '.cloudflared/rokid-personal-ai.yml');
const port = 18448;
const oneTurnMode = process.env.ROKID_ONE_TURN_VOICE === '1';
// Free-form Web research can legitimately continue for several minutes after
// upload. Keep this transport alive beyond the agent's own ten-minute ceiling.
const ttlMs = oneTurnMode ? 900000 : 300000;

if (!outputAixArgument) {
  console.error('usage: node start-named-voice-session.mjs OUTPUT_AIX');
  process.exit(2);
}
if (!existsSync(config)) {
  console.error(`Cloudflare tunnel config not found: ${config}`);
  process.exit(2);
}

const outputAix = resolve(outputAixArgument);
const token = randomBytes(32).toString('hex');
const baseEnvironment = { ...process.env };
for (const name of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'ROKID_KNOWLEDGE_TOKEN',
  'ROKID_KNOWLEDGE_QUESTION',
  'ROKID_VOICE_KNOWLEDGE_TOKEN',
]) delete baseEnvironment[name];
const relayEnvironment = {
  ...baseEnvironment,
  ROKID_VOICE_KNOWLEDGE_TOKEN: token,
  ROKID_VOICE_KNOWLEDGE_PORT: String(port),
  ROKID_VOICE_KNOWLEDGE_TTL_MS: String(ttlMs),
  ROKID_VOICE_KNOWLEDGE_ORIGIN: origin,
};

let relay = null;
let tunnel = null;
let cleaning = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup();
    process.exit(130);
  });
}

try {
  const relayScript = oneTurnMode
    ? resolve(import.meta.dirname, '../daily-gateway/one-turn-voice-relay.mjs')
    : resolve(import.meta.dirname, 'voice-knowledge-relay.mjs');
  relay = spawn(process.execPath, [relayScript], {
    cwd: import.meta.dirname,
    env: relayEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.pipe(process.stdout);
  relay.stderr.pipe(process.stderr);
  await waitForRelay(relay, 5000);

  tunnel = spawn(
    cloudflared,
    ['tunnel', '--no-autoupdate', '--config', config, 'run'],
    {
      cwd: import.meta.dirname,
      env: baseEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  tunnel.stdout.pipe(process.stdout);
  tunnel.stderr.pipe(process.stderr);
  const publicHealth = await waitForPublicHealth(tunnel);

  execFileSync(process.execPath, [resolve(import.meta.dirname, 'prepare-voice-aix.mjs'), outputAix], {
    cwd: import.meta.dirname,
    env: relayEnvironment,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const sha256 = createHash('sha256').update(readFileSync(outputAix)).digest('hex');
  console.log(
    `SESSION_READY transport=cloudflare-named ` +
      `mode=${oneTurnMode ? 'free-one-turn-voice' : 'voice-knowledge-readonly'} ` +
      `origin=${origin} attempts=${publicHealth.attempts} ` +
      `elapsedMs=${publicHealth.elapsedMs} aix=${outputAix} sha256=${sha256}`,
  );

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    relay.once('error', rejectExit);
    relay.once('close', resolveExit);
  });
  if (exitCode === 0) console.log('SESSION_COMPLETE independentQuestions=true');
  else console.error(`SESSION_ENDED relayExit=${exitCode}`);
  process.exitCode = exitCode === 0 ? 0 : 1;
} catch (error) {
  console.error(`SESSION_FAILED ${error.message}`);
  process.exitCode = 2;
} finally {
  cleanup();
}

function waitForRelay(child, timeoutMs) {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('local voice relay did not become ready')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('READY ')) finish();
    };
    const onExit = (code) => finish(new Error(`local voice relay exited before ready: ${code}`));
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      if (error) rejectReady(error);
      else resolveReady();
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

async function waitForPublicHealth(child) {
  const startedAt = Date.now();
  let attempts = 0;
  while (Date.now() - startedAt < 55000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Cloudflare named tunnel exited before ready: ${child.exitCode ?? child.signalCode}`);
    }
    attempts += 1;
    try {
      const body = await publicHealth();
      if (body.status === 200 && body.payload.ok === true && body.payload.ready === true) {
        return { attempts, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // The fixed tunnel can need a few seconds to register at the edge.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error('Cloudflare named tunnel public health check failed before recording');
}

async function publicHealth() {
  const hostname = new URL(origin).hostname;
  const addresses = await resolve4(hostname);
  if (!addresses.length) throw new Error('fixed Cloudflare origin did not resolve');
  let lastError = null;
  for (const address of addresses) {
    try {
      return await new Promise((resolveHealth, rejectHealth) => {
        const request = https.request({
          hostname,
          servername: hostname,
          port: 443,
          path: '/v1/health',
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          lookup(_hostname, options, callback) {
            if (options?.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
          timeout: 3000,
        }, (response) => {
          const chunks = [];
          let total = 0;
          response.on('data', (chunk) => {
            total += chunk.length;
            if (total > 4096) request.destroy(new Error('public health response too large'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              resolveHealth({
                status: response.statusCode,
                payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              rejectHealth(error);
            }
          });
        });
        request.once('timeout', () => request.destroy(new Error('public health timeout')));
        request.once('error', rejectHealth);
        request.end();
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Cloudflare named tunnel public health failed');
}

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill('SIGTERM');
  if (relay && relay.exitCode === null && relay.signalCode === null) relay.kill('SIGTERM');
  rmSync(outputAix, { force: true });
}
