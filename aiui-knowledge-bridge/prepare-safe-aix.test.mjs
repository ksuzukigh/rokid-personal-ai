import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBaseAix } from './test-fixture.mjs';

test('後片付けAIXは接続情報と通信・録音・保存APIを持たない', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'rokid-knowledge-safe-aix-test-'));
  const output = path.join(work, 'safe.aix');
  const unpacked = path.join(work, 'unpacked');
  try {
    const baseAix = await createBaseAix(work);
    execFileSync(process.execPath, ['prepare-safe-aix.mjs', baseAix, output], { cwd: import.meta.dirname });
    execFileSync('/usr/bin/unzip', ['-qq', output, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    const packageJson = JSON.parse(await readFile(path.join(unpacked, 'package.json'), 'utf8'));
    assert.match(page, /接続情報を消去しました/);
    assert.doesNotMatch(page, /https?:|Bearer|token|wx\.|request|Recorder|Audio|camera|FileSystem|writeFile/);
    assert.equal(packageJson.name, 'rokid-aiui-knowledge-bridge');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
