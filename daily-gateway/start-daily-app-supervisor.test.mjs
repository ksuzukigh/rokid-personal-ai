import assert from 'node:assert/strict';
import test from 'node:test';

import { runDailyAppSupervisor } from './start-daily-app-supervisor.mjs';

test('監視開始と停止を利用者向け秘密なし状態で扱う', async () => {
  const output = [];
  const calls = [];
  const observer = {
    async start() {
      calls.push('observer_start');
      return { ready: true, completion: new Promise(() => {}) };
    },
    async stop() { calls.push('observer_stop'); },
  };
  const supervisor = {
    async stop(reason) { calls.push(`supervisor_stop:${reason}`); },
  };
  const runner = await runDailyAppSupervisor({
    serial: 'Android.local.:34383',
    observer,
    supervisor,
    output: (line) => output.push(line),
  });
  assert.deepEqual(calls, ['observer_start']);
  assert.deepEqual(output, [
    'DAILY_APP_WATCHING serial=Android.local.:34383 executionCapability=none changed=false',
  ]);
  assert.doesNotMatch(output.join('\n'), /token|secret|Bearer/);
  await runner.stop('test');
  assert.deepEqual(calls, ['observer_start', 'observer_stop', 'supervisor_stop:test']);
});

test('実行用入口自身は録音、保存、個人資料検索、外部操作を持たない', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('./start-daily-app-supervisor.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /RecorderManager|RECORD_AUDIO|writeFile|appendFile|createWriteStream/);
  assert.doesNotMatch(source, /runKnowledgePipeline|runWebResearch|applyConfirmed/);
  assert.match(source, /executionCapability=none/);
  assert.match(source, /changed=false/);
});
