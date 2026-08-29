import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDailyAppAix, DAILY_APP_AGENT_ID, DAILY_APP_REMOTE_PATH } from './build-aix.mjs';
import { addDailyAppToIndex } from './update-agent-index.mjs';

test('固定メニューなしの一つの私のAI入口をAIXへまとめる', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'rokid-personal-ai-daily-test-'));
  try {
    const aix = path.join(work, 'daily.aix');
    const unpacked = path.join(work, 'unpacked');
    buildDailyAppAix(aix);
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    const app = await readFile(path.join(unpacked, 'app.js'), 'utf8');
    const manifest = JSON.parse(await readFile(path.join(unpacked, 'app.json'), 'utf8'));
    const files = execFileSync('/usr/bin/find', [unpacked, '-type', 'f'], { encoding: 'utf8' });
    assert.equal(manifest.window.navigationBarTitleText, '私のAI');
    assert.match(page, /state: '準備中…'/);
    assert.doesNotMatch(page, /質問|回答/);
    assert.doesNotMatch(page, /準備が整うと|録音していません|detail|instruction/);
    assert.doesNotMatch(page, /音声をメモ|私の資料に質問|Web検索して保存|3機能/);
    assert.match(app, /^export default/);
    assert.doesNotMatch(app, /^App\(/);
    assert.doesNotMatch(page, /wx\.request|Recorder|getRecorderManager|FileSystem|writeFile|setStorage|camera|purchase|publish/);
    assert.doesNotMatch(files, /\.(png|jpe?g|webp|svg|ico)$/im);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('既存Agentを保ったまま私のAIを一件だけ登録する', () => {
  const existing = { agents: [{ agentId: 'existing-pomodoro', agentName: 'Pomodoro', filePath: '/sdcard/jsai/package/pomodoro.aix' }] };
  const aix = Buffer.from('safe daily AIX fixture');
  const updated = addDailyAppToIndex(existing, aix, { updatedAt: 123456 });
  assert.equal(updated.agents.length, 2);
  assert.deepEqual(updated.agents[0], existing.agents[0]);
  const daily = updated.agents[1];
  assert.equal(daily.agentId, DAILY_APP_AGENT_ID);
  assert.equal(daily.agentName, '私のAI');
  assert.match(daily.agentDesc, /機能メニューを選ばず/);
  assert.doesNotMatch(daily.agentDesc, /音声メモ|個人資料|Web検索/);
  assert.equal(daily.agentLogo, '');
  assert.equal(daily.filePath, DAILY_APP_REMOTE_PATH);
  assert.equal(daily.fileMd5, createHash('md5').update(aix).digest('hex'));
  assert.deepEqual(daily.permissions, []);
});

test('再登録しても私のAIを重複させない', () => {
  const first = addDailyAppToIndex({ agents: [] }, Buffer.from('a'), { updatedAt: 1 });
  const second = addDailyAppToIndex(first, Buffer.from('b'), { updatedAt: 2 });
  assert.equal(second.agents.filter((agent) => agent.agentId === DAILY_APP_AGENT_ID).length, 1);
  assert.equal(second.agents[0].updatedAt, 2);
});
