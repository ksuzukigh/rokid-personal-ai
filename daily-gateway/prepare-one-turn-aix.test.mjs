import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FIXED_DAILY_ORIGIN } from './fixed-session-controller.mjs';
import { prepareOneTurnAix } from './prepare-one-turn-aix.mjs';

test('固定名へ自由文一件を送り私とAIの役割を表示するAIXを作る', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'one-turn-aix-test-'));
  try {
    const aix = path.join(work, 'one-turn.aix');
    const unpacked = path.join(work, 'unpacked');
    prepareOneTurnAix(aix, {
      origin: FIXED_DAILY_ORIGIN,
      token: 't'.repeat(64),
      request: '最近の文書は読める？',
    });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    const app = await readFile(path.join(unpacked, 'app.js'), 'utf8');
    const files = execFileSync('/usr/bin/find', [unpacked, '-type', 'f'], { encoding: 'utf8' });
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/answer/);
    assert.match(page, /request: FREE_REQUEST/);
    assert.match(page, /requestHandledAs !== 'free_one_turn'/);
    assert.match(page, /payload\.changed !== false/);
    assert.match(page, /payload\.ephemeral !== true/);
    assert.match(page, /state: 'AI'/);
    assert.match(page, /detail: `私：\$\{FREE_REQUEST\}\\n\\nAI：\$\{String\(payload\.answer\)/);
    assert.doesNotMatch(page, /質問：|回答：/);
    assert.doesNotMatch(page, /intent|voice_note|web_research_note|personal_knowledge_question/);
    assert.doesNotMatch(page, /__ANSWER_URL__|__SESSION_TOKEN__|__FREE_REQUEST_JSON__/);
    assert.doesNotMatch(page, /Recorder|getRecorderManager|FileSystem|writeFile|setStorage|camera|purchase|publish/);
    assert.doesNotMatch(files, /\.(png|jpe?g|webp|svg|ico)$/im);
    assert.match(app, /^export default/);
    assert.doesNotMatch(app, /\bApp\s*\(/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('別の接続先、短い秘密値、異常な文字をAIXへ入れない', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'one-turn-aix-invalid-'));
  try {
    assert.throws(() => prepareOneTurnAix(path.join(work, 'a.aix'), {
      origin: 'https://example.com', token: 't'.repeat(64), request: '質問',
    }), /fixed private origin/);
    assert.throws(() => prepareOneTurnAix(path.join(work, 'b.aix'), {
      origin: FIXED_DAILY_ORIGIN, token: 'short', request: '質問',
    }), /at least 32 bytes/);
    assert.throws(() => prepareOneTurnAix(path.join(work, 'c.aix'), {
      origin: FIXED_DAILY_ORIGIN, token: 't'.repeat(64), request: '一行目\n二行目',
    }), /control characters/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
