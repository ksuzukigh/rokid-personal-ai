import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';

import { createConfirmationRelay } from './confirmation-relay.mjs';
import { ConfirmationTicketStore } from './confirmation-ticket.mjs';
import { applyConfirmedWebResearch, candidateFromWebResearch } from './web-note-adapter.mjs';
import { createWebConfirmationAix } from './prepare-web-confirmation-aix.mjs';
import { runWebResearch } from './web-research.mjs';

const options = parseArgs(process.argv.slice(2));
const origin = 'https://personal-ai.example.com';
const port = 18448;
const ttlMs = 300_000;
const cloudflared = '/opt/homebrew/bin/cloudflared';
const config = process.env.ROKID_CLOUDFLARED_CONFIG ?? path.join(homedir(), '.cloudflared/rokid-personal-ai.yml');
if (!options.request || !options.output || !existsSync(config) || !existsSync(cloudflared)) {
  console.error('usage: node start-web-research-session.mjs --request <text> --output <aix>');
  process.exit(2);
}

const output = path.resolve(options.output);
const environment = { ...process.env };
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ROKID_KNOWLEDGE_TOKEN', 'ROKID_VOICE_KNOWLEDGE_TOKEN']) delete environment[name];
const bearer = randomBytes(32).toString('hex');
const store = new ConfirmationTicketStore({ ttlMs });
let relay;
let tunnel;
let cleaning = false;
let decisionResolve;
const decisionPromise = new Promise((resolve) => { decisionResolve = resolve; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });

try {
  const research = await runWebResearch(options.request);
  const candidate = candidateFromWebResearch(research.request, research);
  console.log(JSON.stringify({
    event: 'WEB_RESEARCH_READY', request: research.request, summary: research.summary,
    sources: research.sources, audit: research.audit,
  }));
  relay = createConfirmationRelay({ store, bearer, onDecision: async (decision) => {
    const applied = decision.status === 'confirmed'
      ? await applyConfirmedWebResearch(candidate, research.request, research, decision)
      : {};
    const outcome = { ...decision, ...applied };
    decisionResolve(outcome);
    return applied;
  } });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(port, '127.0.0.1', resolve); });
  tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--config', config, 'run'], {
    cwd: import.meta.dirname, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  tunnel.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForPublicHealth(tunnel, bearer);
  const ticket = store.issue(candidate);
  createWebConfirmationAix(candidate, ticket, research.request, research, { origin, bearer }, output);
  console.log(JSON.stringify({
    event: 'SESSION_READY', mode: 'web-research-note', recording: false, webSearch: 'live',
    sourceCount: research.sources.length, target: 'Rokid Web検索メモ試用.md',
    candidateId: candidate.candidateId, expiresAt: ticket.expiresAt, aix: output,
    aixSha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  }));
  const outcome = await Promise.race([
    decisionPromise,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'expired', accepted: false }), ttlMs + 500)),
  ]);
  console.log(JSON.stringify({
    event: 'SESSION_RESULT', status: outcome.status, accepted: outcome.accepted === true,
    saved: outcome.applied === true, changed: outcome.changed === true,
  }));
} catch (error) {
  console.error(`SESSION_FAILED ${error.message}`);
  process.exitCode = 2;
} finally { cleanup(); }

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill('SIGTERM');
  if (relay?.listening) { relay.close(); relay.closeAllConnections?.(); }
  rmSync(output, { force: true });
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--request') result.request = values[++index];
    else if (values[index] === '--output') result.output = values[++index];
  }
  return result;
}

async function waitForPublicHealth(child, token) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 55_000) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Cloudflare tunnel exited before ready');
    try { const result = await publicHealth(token); if (result.status === 200 && result.body.ok === true && result.body.ready === true) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('public web-research confirmation health check timed out');
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
          lookup(_hostname, config, callback) { if (config?.all) callback(null, [{ address, family: 4 }]); else callback(null, address, 4); },
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
