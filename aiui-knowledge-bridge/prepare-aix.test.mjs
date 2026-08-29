import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBaseAix } from './test-fixture.mjs';

const origin = 'https://personal-ai.example.com';

test('一時AIXは選択した自由質問と固定経路だけを持ち、録音・保存APIを持たない', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'rokid-knowledge-aix-test-'));
  const output = path.join(work, 'test.aix');
  const unpacked = path.join(work, 'unpacked');
  const token = 't'.repeat(64);
  const question = 'ねえ、Rokidの個人AIづくり、今どこまで進んでいて次は何をするの？';
  try {
    const baseAix = await createBaseAix(work);
    execFileSync(process.execPath, ['prepare-aix.mjs', baseAix, output], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        ROKID_KNOWLEDGE_ORIGIN: origin,
        ROKID_KNOWLEDGE_TOKEN: token,
        ROKID_KNOWLEDGE_QUESTION: question,
      },
    });
    execFileSync('/usr/bin/unzip', ['-qq', output, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    const agents = await readFile(path.join(unpacked, 'AGENTS.md'), 'utf8');
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/ask/);
    assert.doesNotMatch(page, /private-tailnet\.ts\.net/);
    assert.match(page, /\/v1\/ask/);
    assert.match(page, /\/v1\/cancel/);
    assert.match(page, /ねえ、Rokidの個人AIづくり/);
    assert.doesNotMatch(page, /Rokidを使って私が今まで作ったもの/);
    assert.match(page, /payload\.answer\.length <= 160/);
    assert.match(page, /timeout: 70000/);
    assert.match(agents, /マイク、録音、音声認識、カメラ、保存、書き込み、実処理を禁止/);
    assert.doesNotMatch(page, /RecorderManager|getRecorderManager|AudioRecord|RECORD_AUDIO|camera|FileSystemManager|writeFile/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('実機接続確認モードはLunaとObsidianに到達しない', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'rokid-knowledge-health-aix-test-'));
  const output = path.join(work, 'health.aix');
  const unpacked = path.join(work, 'unpacked');
  try {
    const baseAix = await createBaseAix(work);
    execFileSync(process.execPath, ['prepare-aix.mjs', baseAix, output], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        ROKID_KNOWLEDGE_ORIGIN: origin,
        ROKID_KNOWLEDGE_TOKEN: 'h'.repeat(64),
        ROKID_KNOWLEDGE_HEALTH_ONLY: '1',
      },
    });
    execFileSync('/usr/bin/unzip', ['-qq', output, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    const agents = await readFile(path.join(unpacked, 'AGENTS.md'), 'utf8');
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/health/);
    assert.doesNotMatch(page, /\/v1\/ask/);
    assert.match(page, /録音していません/);
    assert.match(agents, /AIとObsidianは使わない/);
    assert.doesNotMatch(page, /RecorderManager|getRecorderManager|AudioRecord|RECORD_AUDIO|camera|FileSystemManager|writeFile/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
