import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const [baseAixArgument, outputAixArgument] = process.argv.slice(2);
const origin = 'https://your-tailnet.ts.net';
const socket = resolve(homedir(), 'Library/Application Support/RokidTailscale/tailscaled.sock');
const tailscale = '/opt/homebrew/bin/tailscale';
const port = 18448;
const ttlMs = 300000;

if (!baseAixArgument || !outputAixArgument) {
  console.error('usage: node start-session.mjs BASE_AIX OUTPUT_AIX');
  process.exit(2);
}

const baseAix = resolve(baseAixArgument);
const outputAix = resolve(outputAixArgument);
const token = randomBytes(32).toString('hex');
const childEnvironment = { ...process.env };
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete childEnvironment[name];
Object.assign(childEnvironment, {
  ROKID_KNOWLEDGE_TOKEN: token,
  ROKID_KNOWLEDGE_PORT: String(port),
  ROKID_KNOWLEDGE_TTL_MS: String(ttlMs),
  ROKID_KNOWLEDGE_ORIGIN: origin,
});

let relay = null;
let funnelEnabled = false;
let cleaning = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup();
    process.exit(130);
  });
}

try {
  relay = spawn(process.execPath, [resolve(import.meta.dirname, 'relay.mjs')], {
    cwd: import.meta.dirname,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.pipe(process.stdout);
  relay.stderr.pipe(process.stderr);
  await waitForRelay(relay, 5000);

  runTailscale(['funnel', '--bg', `http://127.0.0.1:${port}`]);
  funnelEnabled = true;
  const publicHealth = await waitForPublicHealth();

  execFileSync(process.execPath, [resolve(import.meta.dirname, 'prepare-aix.mjs'), baseAix, outputAix], {
    cwd: import.meta.dirname,
    env: childEnvironment,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const sha256 = createHash('sha256').update(readFileSync(outputAix)).digest('hex');
  console.log(
    `SESSION_READY attempts=${publicHealth.attempts} elapsedMs=${publicHealth.elapsedMs} ` +
      `aix=${outputAix} sha256=${sha256}`,
  );

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    relay.once('error', rejectExit);
    relay.once('close', resolveExit);
  });
  if (exitCode === 0) console.log('SESSION_COMPLETE oneRequest=true');
  else console.error(`SESSION_ENDED relayExit=${exitCode}`);
  process.exitCode = exitCode === 0 ? 0 : 1;
} catch (error) {
  console.error(`SESSION_FAILED ${error.message}`);
  process.exitCode = 2;
} finally {
  cleanup();
}

function runTailscale(argumentsList) {
  execFileSync(tailscale, [`--socket=${socket}`, ...argumentsList], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function waitForRelay(child, timeoutMs) {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('local relay did not become ready')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('READY ')) finish();
    };
    const onExit = (code) => finish(new Error(`local relay exited before ready: ${code}`));
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

async function waitForPublicHealth() {
  const startedAt = Date.now();
  let attempts = 0;
  while (Date.now() - startedAt < 55000) {
    attempts += 1;
    try {
      const body = await publicHealthWithVerifiedDns();
      if (body.status === 200 && body.payload.ok === true && body.payload.ready === true) {
        return { attempts, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // The fixed Funnel may need a moment before it is reachable.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error('fixed public health check failed');
}

async function publicHealthWithVerifiedDns() {
  const hostname = new URL(origin).hostname;
  const addresses = await resolve4(hostname);
  if (!addresses.length) throw new Error('fixed Funnel origin did not resolve');
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
  throw lastError ?? new Error('fixed Funnel public health failed');
}

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (funnelEnabled) {
    spawnSync(tailscale, [`--socket=${socket}`, 'funnel', '--https=443', 'off'], { stdio: 'ignore' });
  }
  if (relay && relay.exitCode === null && relay.signalCode === null) relay.kill('SIGTERM');
  rmSync(outputAix, { force: true });
}
