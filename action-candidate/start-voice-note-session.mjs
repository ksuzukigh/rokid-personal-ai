import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';

import { createVoiceNoteRelay } from './voice-note-relay.mjs';

const output = path.resolve(process.argv[2] ?? '');
const origin = 'https://personal-ai.example.com';
const port = 18448;
const ttlMs = 600_000;
const cloudflared = '/opt/homebrew/bin/cloudflared';
const config = process.env.ROKID_CLOUDFLARED_CONFIG ?? path.join(homedir(), '.cloudflared/rokid-personal-ai.yml');
if (!process.argv[2] || !existsSync(config) || !existsSync(cloudflared)) {
  console.error('usage: node start-voice-note-session.mjs OUTPUT_AIX');
  process.exit(2);
}

const bearer = randomBytes(32).toString('hex');
const environment = { ...process.env };
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ROKID_KNOWLEDGE_TOKEN', 'ROKID_VOICE_KNOWLEDGE_TOKEN']) delete environment[name];
let relay;
let tunnel;
let cleaning = false;
let decisionResolve;
const decisionPromise = new Promise((resolve) => { decisionResolve = resolve; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });

try {
  relay = createVoiceNoteRelay({ token: bearer, port, ttlMs, onDecision: decisionResolve });
  await relay.listen();
  tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--config', config, 'run'], {
    cwd: import.meta.dirname, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  tunnel.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForPublicHealth(tunnel, bearer);
  const builderEnvironment = { ...environment, ROKID_VOICE_NOTE_ORIGIN: origin, ROKID_VOICE_NOTE_TOKEN: bearer };
  const builder = spawn(process.execPath, [path.resolve(import.meta.dirname, 'prepare-voice-note-aix.mjs'), output], {
    cwd: import.meta.dirname, env: builderEnvironment, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const builderCode = await new Promise((resolve, reject) => { builder.once('error', reject); builder.once('close', resolve); });
  if (builderCode !== 0) throw new Error(`voice note AIX builder exited ${builderCode}`);
  console.log(JSON.stringify({
    event: 'SESSION_READY', mode: 'one-shot-voice-note', origin, recordingCount: 1,
    recordingMaximumSeconds: 10, audioStorage: false, webSearch: false,
    target: 'Rokid個人AIメモ試用.md', aix: output,
    aixSha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  }));
  const outcome = await Promise.race([
    decisionPromise,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'expired', accepted: false }), ttlMs)),
  ]);
  console.log(JSON.stringify({
    event: 'SESSION_RESULT', status: outcome.status, accepted: outcome.accepted === true,
    transcript: outcome.transcript ?? '', saved: outcome.applied === true, changed: outcome.changed === true,
  }));
} catch (error) {
  console.error(`SESSION_FAILED ${error.message}`);
  process.exitCode = 2;
} finally { await cleanup(); }

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill('SIGTERM');
  rmSync(output, { force: true });
  if (relay) await relay.close().catch(() => {});
}

async function waitForPublicHealth(child, token) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 55_000) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Cloudflare tunnel exited before ready');
    try { const result = await publicHealth(token); if (result.status === 200 && result.body.ok === true && result.body.ready === true) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('public voice-note health check timed out');
}

async function publicHealth(token) {
  const hostname = new URL(origin).hostname;
  const addresses = await resolve4(hostname);
  let lastError;
  for (const address of addresses) {
    try {
      return await new Promise((resolve, reject) => {
        const request = https.request({ hostname, servername: hostname, port: 443, path: '/v1/health', method: 'POST',
          headers: { authorization: `Bearer ${token}` }, timeout: 3000,
          lookup(_hostname, options, callback) { if (options?.all) callback(null, [{ address, family: 4 }]); else callback(null, address, 4); },
        }, (response) => {
          const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
        });
        request.once('timeout', () => request.destroy(new Error('health timeout')));
        request.once('error', reject); request.end();
      });
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('fixed hostname did not resolve');
}
