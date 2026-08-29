import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createOneTurnVoiceRelay } from './one-turn-voice-relay.mjs';

const [outputArgument] = process.argv.slice(2);
const origin = 'https://personal-ai.example.com';
const port = Number(process.env.ROKID_VOICE_KNOWLEDGE_PORT ?? 18448);
const ttlMs = Number(process.env.ROKID_VOICE_KNOWLEDGE_TTL_MS ?? 900000);
const token = process.env.ROKID_VOICE_KNOWLEDGE_TOKEN ?? '';

if (!outputArgument) fail('usage: node start-mobile-voice-session.mjs OUTPUT_AIX');
if (Buffer.byteLength(token, 'utf8') < 32) fail('mobile voice session token is missing');
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('mobile voice session port is invalid');
if (!Number.isInteger(ttlMs) || ttlMs < 60000 || ttlMs > 1800000) fail('mobile voice session lifetime is invalid');

const outputAix = resolve(outputArgument);
let relay = null;
let stopping = false;

async function stopForSignal() {
  if (stopping) return;
  stopping = true;
  await relay?.close().catch((error) => {
    console.error(`CLOSE_FAILED reason=signal error=${error.message}`);
  });
  process.exit(130);
}

process.once('SIGINT', stopForSignal);
process.once('SIGTERM', stopForSignal);

try {
  relay = createOneTurnVoiceRelay({
    token,
    port,
    ttlMs,
    exitOnFinish: true,
  });
  const address = await relay.listen();
  const environment = {
    ...process.env,
    ROKID_ONE_TURN_VOICE: '1',
    ROKID_VOICE_KNOWLEDGE_ORIGIN: origin,
    ROKID_VOICE_KNOWLEDGE_TOKEN: token,
  };
  execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, '../aiui-knowledge-bridge/prepare-voice-aix.mjs'), outputAix],
    { cwd: import.meta.dirname, env: environment, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (!existsSync(outputAix)) throw new Error('mobile voice AIX was not created');
  console.log(
    `SESSION_READY transport=cloudflare-persistent mode=codex-conversation-voice ` +
      `origin=${origin} localPort=${address.port}`,
  );
  await new Promise(() => {});
} catch (error) {
  console.error(`SESSION_FAILED ${error.message}`);
  process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
