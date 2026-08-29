import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixedDailySessionController, FIXED_DAILY_ORIGIN } from './fixed-session-controller.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

test('受け口の準備後だけ固定名を確認し、受け口終了で両方止める', async () => {
  const receiverDone = deferred();
  const events = [];
  let receiverStopped = 0;
  let tunnelStopped = 0;
  const controller = createFixedDailySessionController({
    environment: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'remove-me',
      ROKID_DAILY_SESSION_TOKEN: 'remove-old-daily-token',
    },
    tokenFactory: () => 'n'.repeat(64),
    pathExists: () => true,
    now: () => 1000,
    async startReceiver({ environment }) {
      events.push('receiver');
      assert.equal(environment.OPENAI_API_KEY, undefined);
      assert.equal(environment.ROKID_DAILY_SESSION_TOKEN, 'n'.repeat(64));
      return {
        completion: receiverDone.promise,
        completionStatus: () => false,
        async stop() { receiverStopped += 1; },
      };
    },
    async startTunnel({ environment }) {
      events.push('tunnel');
      assert.equal(environment.OPENAI_API_KEY, undefined);
      assert.equal(environment.ROKID_DAILY_SESSION_TOKEN, undefined);
      return {
        completion: new Promise(() => {}),
        completionStatus: () => false,
        async stop() { tunnelStopped += 1; },
      };
    },
    async checkPublicHealth(origin, token) {
      events.push('health');
      assert.equal(origin, FIXED_DAILY_ORIGIN);
      assert.equal(token, 'n'.repeat(64));
      return { status: 200, payload: { ok: true, ready: true } };
    },
  });

  const session = await controller.start();
  assert.deepEqual(events, ['receiver', 'tunnel', 'health']);
  assert.equal(session.expiresAt, 301000);
  receiverDone.resolve({ code: 0, signal: null });
  assert.deepEqual(await session.completion, { code: 0, signal: null });
  assert.equal(receiverStopped, 1);
  assert.equal(tunnelStopped, 1);
});

test('固定名の公開確認が失敗したら受け口とトンネルを両方止める', async () => {
  let receiverStopped = 0;
  let tunnelStopped = 0;
  const never = new Promise(() => {});
  const controller = createFixedDailySessionController({
    tokenFactory: () => 'x'.repeat(64),
    pathExists: () => true,
    healthTimeoutMs: 5,
    healthRetryMs: 1,
    startReceiver: async () => ({
      completion: never,
      completionStatus: () => false,
      async stop() { receiverStopped += 1; },
    }),
    startTunnel: async () => ({
      completion: never,
      completionStatus: () => false,
      async stop() { tunnelStopped += 1; },
    }),
    checkPublicHealth: async () => { throw new Error('unreachable'); },
  });
  await assert.rejects(controller.start(), /health check failed/);
  assert.equal(receiverStopped, 1);
  assert.equal(tunnelStopped, 1);
});

test('固定名以外、長すぎる期限、短い秘密値を開始前に拒否する', async () => {
  assert.throws(
    () => createFixedDailySessionController({ origin: 'https://example.com' }),
    /fixed private hostname/,
  );
  assert.throws(
    () => createFixedDailySessionController({ ttlMs: 600001 }),
    /invalid daily ttl/,
  );
  const controller = createFixedDailySessionController({
    tokenFactory: () => 'short',
    pathExists: () => true,
  });
  await assert.rejects(controller.start(), /at least 32 bytes/);
});

test('制御部品は秘密値をCloudflare環境へ渡さず、ファイル変更と録音を持たない', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./fixed-session-controller.mjs', import.meta.url), 'utf8');
  assert.match(source, /sanitizedEnvironment/);
  assert.match(source, /receiver_finished/);
  assert.match(source, /receiver_failed/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|RecorderManager|RECORD_AUDIO/);
  assert.doesNotMatch(source, /runKnowledgePipeline|runWebResearch|applyConfirmed/);
});
