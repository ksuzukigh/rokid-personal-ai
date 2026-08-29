import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildActionCandidate } from './action-candidate.mjs';
import { createConfirmationRelay } from './confirmation-relay.mjs';
import { ConfirmationTicketStore } from './confirmation-ticket.mjs';
import { createConfirmationAix } from './prepare-confirmation-aix.mjs';
import { applyConfirmedCandidate } from './trial-note-adapter.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const origin = 'https://personal-ai.example.com';
const port = 18448;
const ttlMs = 300_000;
const cloudflared = '/opt/homebrew/bin/cloudflared';
const config = process.env.ROKID_CLOUDFLARED_CONFIG ?? path.join(homedir(), '.cloudflared/rokid-personal-ai.yml');

function args(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--utterance') parsed.utterance = values[++index];
    else if (values[index] === '--output') parsed.output = values[++index];
    else if (values[index] === '--apply-trial-note') parsed.applyTrialNote = true;
  }
  return parsed;
}

const options = args(process.argv.slice(2));
if (!options.utterance || !options.output || !existsSync(config) || !existsSync(cloudflared)) {
  console.error('usage: node start-confirmation-session.mjs --utterance <text> --output <aix>');
  process.exit(2);
}

const output = path.resolve(options.output);
const environment = { ...process.env };
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ROKID_KNOWLEDGE_TOKEN', 'ROKID_VOICE_KNOWLEDGE_TOKEN']) delete environment[name];
const bearer = randomBytes(32).toString('hex');
const store = new ConfirmationTicketStore({ ttlMs });
let relay;
let tunnel;
let decisionResolve;
const decisionPromise = new Promise((resolve) => { decisionResolve = resolve; });
let cleaning = false;

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });

try {
  const candidate = await buildActionCandidate({ utterance: options.utterance });
  relay = createConfirmationRelay({ store, bearer, onDecision: async (decision) => {
    const applied = options.applyTrialNote && decision.status === 'confirmed' ? await applyConfirmedCandidate(candidate, decision) : {};
    decisionResolve({ ...decision, ...applied });
    return applied;
  } });
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(port, '127.0.0.1', resolve);
  });
  tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--config', config, 'run'], {
    cwd: MODULE_DIR, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  tunnel.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForPublicHealth(tunnel, bearer);
  const ticket = store.issue(candidate);
  createConfirmationAix(candidate, ticket, { origin, bearer, applyOnConfirm: options.applyTrialNote }, output);
  const aixSha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
  console.log(JSON.stringify({
    event: 'SESSION_READY', mode: options.applyTrialNote ? 'trial-note-write' : 'confirmation-only', origin,
    candidateId: candidate.candidateId, ticketId: ticket.ticketId,
    expiresAt: ticket.expiresAt, aix: output, aixSha256,
    model: candidate.audit.model, auth: candidate.audit.auth,
    recording: false, protectedResourceChanged: false,
  }));
  const outcome = await Promise.race([
    decisionPromise,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'expired', accepted: false }), ttlMs + 500)),
  ]);
  console.log(JSON.stringify({
    event: 'SESSION_RESULT', status: outcome.status,
    accepted: outcome.accepted === true,
    confirmationRecorded: outcome.confirmationRecorded === true,
    protectedResourceChanged: outcome.changed === true,
    audit: store.auditRecords(),
  }));
} catch (error) {
  console.error(`SESSION_FAILED ${error.message}`);
  process.exitCode = 2;
} finally {
  cleanup();
}

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill('SIGTERM');
  tunnel?.stdout?.destroy();
  tunnel?.stderr?.destroy();
  if (relay?.listening) {
    relay.close();
    relay.closeAllConnections?.();
  }
  rmSync(output, { force: true });
}

async function waitForPublicHealth(child, token) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 55_000) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Cloudflare tunnel exited before ready');
    try {
      const result = await publicHealth(token);
      if (result.status === 200 && result.body.ok === true && result.body.ready === true) return;
    } catch { /* retry while the fixed tunnel registers */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('public confirmation health check timed out');
}

async function publicHealth(token) {
  const hostname = new URL(origin).hostname;
  const addresses = await resolve4(hostname);
  let lastError;
  for (const address of addresses) {
    try {
      return await new Promise((resolve, reject) => {
        const request = https.request({
          hostname, servername: hostname, port: 443, path: '/v1/health', method: 'POST',
          headers: { authorization: `Bearer ${token}` }, timeout: 3000,
          lookup(_hostname, lookupOptions, callback) {
            if (lookupOptions?.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
        }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); }
            catch (error) { reject(error); }
          });
        });
        request.once('timeout', () => request.destroy(new Error('health timeout')));
        request.once('error', reject);
        request.end();
      });
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('fixed hostname did not resolve');
}
