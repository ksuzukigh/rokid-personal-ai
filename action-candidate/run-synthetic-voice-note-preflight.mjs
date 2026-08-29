import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVoiceNoteRelay } from './voice-note-relay.mjs';

const pcmPath = process.argv[2];
if (!pcmPath) {
  console.error('usage: node run-synthetic-voice-note-preflight.mjs INPUT_PCM');
  process.exit(2);
}
const work = await realpath(await mkdtemp(join(tmpdir(), 'rokid-voice-note-preflight-')));
const targetPath = join(work, 'trial.md');
const token = randomBytes(32).toString('hex');
const relay = createVoiceNoteRelay({ token, targetPath, ttlMs: 60_000 });
try {
  await writeFile(targetPath, '# 合成音声事前確認\n');
  const address = await relay.listen();
  const base = `http://${address.host}:${address.port}`;
  const audio = await fetch(`${base}/v1/transcribe`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'x-request-id': 'synthetic_voice_note_01',
      'x-audio-format': 'pcm_s16le',
      'x-sample-rate': '16000',
      'x-channels': '1',
    },
    body: await readFile(pcmPath),
  });
  assert.equal(audio.status, 200);
  const preview = await audio.json();
  const ticket = { ticketId: preview.ticketId, candidateId: preview.candidateId, confirmationToken: preview.confirmationToken };
  const before = await readFile(targetPath, 'utf8');
  assert.doesNotMatch(before, new RegExp(escapeRegExp(preview.text)));
  const confirmed = await fetch(`${base}/v1/confirm-note`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(ticket),
  });
  assert.equal(confirmed.status, 200);
  const outcome = await confirmed.json();
  const after = await readFile(targetPath, 'utf8');
  assert.match(after, new RegExp(escapeRegExp(preview.text)));
  console.log(JSON.stringify({
    result: 'PASS',
    input: 'macOS synthetic Japanese voice',
    transcript: preview.text,
    previewEqualsSavedText: true,
    savedAfterConfirmationOnly: true,
    changed: outcome.changed === true,
    realRecording: false,
    realDevice: false,
  }));
} finally {
  await relay.close();
  await rm(work, { recursive: true, force: true });
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
