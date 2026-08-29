import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FIXED_DAILY_ORIGIN } from './fixed-session-controller.mjs';
import { prepareRouteAix } from './prepare-route-aix.mjs';

test('固定名へ文字一件を送り行き先だけ表示するAIXを作る', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'daily-route-aix-test-'));
  try {
    const aix = path.join(work, 'route.aix');
    const unpacked = path.join(work, 'unpacked');
    prepareRouteAix(aix, {
      origin: FIXED_DAILY_ORIGIN,
      token: 't'.repeat(64),
      utterance: '私のRokid作りは今どこまで進んでる？',
    });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    const files = execFileSync('/usr/bin/find', [unpacked, '-type', 'f'], { encoding: 'utf8' });
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/route/);
    assert.match(page, /utterance: UTTERANCE/);
    assert.match(page, /executionCapability !== 'none'/);
    assert.match(page, /payload\.changed !== false/);
    assert.match(page, /録音前に、改めて確認します/);
    assert.match(page, /読み取り専用。まだ検索していません/);
    assert.match(page, /保存前に内容を確認します/);
    assert.doesNotMatch(page, /__ROUTE_URL__|__SESSION_TOKEN__|__UTTERANCE_JSON__/);
    assert.doesNotMatch(page, /Recorder|getRecorderManager|FileSystem|writeFile|setStorage|camera|purchase|publish/);
    assert.doesNotMatch(files, /\.(png|jpe?g|webp|svg|ico)$/im);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('別の接続先、短い秘密値、異常な文字をAIXへ入れない', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'daily-route-aix-invalid-'));
  try {
    assert.throws(() => prepareRouteAix(path.join(work, 'a.aix'), {
      origin: 'https://example.com', token: 't'.repeat(64), utterance: '質問',
    }), /fixed private origin/);
    assert.throws(() => prepareRouteAix(path.join(work, 'b.aix'), {
      origin: FIXED_DAILY_ORIGIN, token: 'short', utterance: '質問',
    }), /at least 32 bytes/);
    assert.throws(() => prepareRouteAix(path.join(work, 'c.aix'), {
      origin: FIXED_DAILY_ORIGIN, token: 't'.repeat(64), utterance: '一行目\n二行目',
    }), /control characters/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
