import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('./prepare-voice-note-aix.mjs', import.meta.url));

test('音声メモAIXは原文確認後の一回保存だけを持つ', () => {
  const work = mkdtempSync(join(tmpdir(), 'voice-note-aix-test-'));
  const aix = join(work, 'live.aix');
  const unpacked = join(work, 'unpacked');
  const token = 'n'.repeat(64);
  try {
    execFileSync(process.execPath, [builder, aix], { env: {
      ...process.env,
      ROKID_VOICE_NOTE_ORIGIN: 'https://personal-ai.example.com',
      ROKID_VOICE_NOTE_TOKEN: token,
    }, stdio: 'ignore' });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = readFileSync(join(unpacked, 'pages/index/index.ink'), 'utf8');
    const agents = readFileSync(join(unpacked, 'AGENTS.md'), 'utf8');
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/transcribe/);
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/confirm-note/);
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/cancel-note/);
    assert.match(page, /const CONFIRMATION_TIMEOUT_MS = 120000;/);
    assert.match(page, /state: '完了'/);
    assert.match(page, /detail: `AI：\$\{body\.text \|\| this\.data\.recognizedText\}`/);
    assert.equal(page.split(token).length - 1, 1);
    assert.match(agents, /AIによる要約・言い換え、Web検索、二回目の録音は行わない/);
    assert.doesNotMatch(page, /setStorage|FileSystemManager|appendFile|writeFile/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
