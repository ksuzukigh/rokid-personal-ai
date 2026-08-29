import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersonalAiMacService } from './personal-ai-mac-service.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

test('Mac起動後はADBを待たず外出用の安全な開始口を待受ける', async () => {
  const done = deferred();
  const calls = [];
  const output = [];
  const service = createPersonalAiMacService({
    createGateway(options) {
      assert.equal(typeof options.output, 'function');
      return {
        async start() {
          calls.push('gateway_start');
          return { completion: done.promise, recordingStarted: false, changed: false };
        },
        async stop() {
          calls.push('gateway_stop');
          done.resolve();
        },
      };
    },
    output: (line) => output.push(line),
  });
  const running = service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['gateway_start']);
  assert.match(output.join('\n'), /route=internet/);
  await service.stop();
  await running.completion;
  assert.deepEqual(calls, ['gateway_start', 'gateway_stop']);
});

test('Mac待受けは旧分類、保存、Rokid Control、ADBを持たない', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('./personal-ai-mac-service.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /mobile-personal-ai-gateway\.mjs/);
  assert.doesNotMatch(source, /adb-|resolveRokidDevice|Rokid Control/);
  assert.doesNotMatch(source, /intent-router|runKnowledgePipeline|appendFile|createWriteStream/);
  assert.match(source, /recordingStarted=false/);
  assert.match(source, /changed=false/);
});
