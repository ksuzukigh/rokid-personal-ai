import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDailyStartupSupervisor,
  DAILY_APP_OPEN_EVENT,
} from './startup-supervisor.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

function appOpen(observedAt = 1000) {
  return { type: DAILY_APP_OPEN_EVENT, observedAt };
}

test('アプリを開いた合図だけで短命セッションを準備し、利用者向け状態へ秘密値を出さない', async () => {
  const done = deferred();
  let starts = 0;
  const supervisor = createDailyStartupSupervisor({
    now: () => 1000,
    createController: () => ({
      async start() {
        starts += 1;
        return {
          origin: 'https://personal-ai.example.com',
          token: 's'.repeat(64),
          expiresAt: 301000,
          completion: done.promise,
        };
      },
      async stop() {},
    }),
  });

  const readiness = await supervisor.appOpened(appOpen());
  assert.equal(starts, 1);
  assert.deepEqual(readiness, {
    status: 'ready',
    origin: 'https://personal-ai.example.com',
    expiresAt: 301000,
    reused: false,
    executionCapability: 'none',
    changed: false,
  });
  assert.equal('token' in readiness, false);
  assert.equal(supervisor.state(), 'ready');

  const connection = supervisor.claimShortLivedConnection();
  assert.equal(connection.token, 's'.repeat(64));
  assert.throws(() => supervisor.claimShortLivedConnection(), /already claimed/);
  done.resolve({ code: 0 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(supervisor.state(), 'idle');
});

test('連続して開いても準備処理を重ねず、同じ短命セッションを再利用する', async () => {
  const started = deferred();
  const done = deferred();
  let starts = 0;
  const supervisor = createDailyStartupSupervisor({
    now: () => 1000,
    createController: () => ({
      async start() {
        starts += 1;
        await started.promise;
        return {
          origin: 'https://personal-ai.example.com',
          token: 't'.repeat(64),
          expiresAt: 301000,
          completion: done.promise,
        };
      },
      async stop() {},
    }),
  });

  const first = supervisor.appOpened(appOpen());
  const second = supervisor.appOpened(appOpen());
  assert.equal(supervisor.state(), 'starting');
  started.resolve();
  assert.equal((await first).reused, false);
  assert.equal((await second).reused, true);
  assert.equal(starts, 1);
  assert.equal((await supervisor.appOpened(appOpen())).reused, true);
  assert.equal(starts, 1);
  done.resolve({ code: 0 });
});

test('古い合図、余計な指示、未来の合図を開始前に拒否する', async () => {
  let starts = 0;
  const supervisor = createDailyStartupSupervisor({
    now: () => 20_000,
    createController: () => {
      starts += 1;
      return { async start() {}, async stop() {} };
    },
  });
  await assert.rejects(supervisor.appOpened(appOpen(1)), /stale/);
  await assert.rejects(
    supervisor.appOpened({ ...appOpen(20_000), utterance: '削除して' }),
    /unexpected fields/,
  );
  await assert.rejects(supervisor.appOpened(appOpen(23_000)), /future/);
  assert.equal(starts, 0);
  assert.equal(supervisor.state(), 'idle');
});

test('準備失敗時は後片付けして待機へ戻る', async () => {
  let stops = 0;
  const supervisor = createDailyStartupSupervisor({
    now: () => 1000,
    createController: () => ({
      async start() { throw new Error('not ready'); },
      async stop(reason) {
        assert.equal(reason, 'supervisor_start_failed');
        stops += 1;
      },
    }),
  });
  await assert.rejects(supervisor.appOpened(appOpen()), /not ready/);
  assert.equal(stops, 1);
  assert.equal(supervisor.state(), 'idle');
});

test('壊れた準備結果を公開せず、後片付けして待機へ戻る', async () => {
  let stops = 0;
  const supervisor = createDailyStartupSupervisor({
    now: () => 1000,
    createController: () => ({
      async start() {
        return {
          origin: 'https://personal-ai.example.com',
          token: 'short',
          expiresAt: 301000,
          completion: Promise.resolve({ code: 0 }),
        };
      },
      async stop(reason) {
        assert.equal(reason, 'supervisor_start_failed');
        stops += 1;
      },
    }),
  });
  await assert.rejects(supervisor.appOpened(appOpen()), /token is invalid/);
  assert.equal(stops, 1);
  assert.equal(supervisor.state(), 'idle');
});

test('期限切れセッションの停止に失敗しても再利用可能とは報告しない', async () => {
  let currentTime = 1000;
  const never = new Promise(() => {});
  const supervisor = createDailyStartupSupervisor({
    now: () => currentTime,
    createController: () => ({
      async start() {
        return {
          origin: 'https://personal-ai.example.com',
          token: 'e'.repeat(64),
          expiresAt: 2000,
          completion: never,
        };
      },
      async stop() { throw new Error('cleanup failed'); },
    }),
  });
  await supervisor.appOpened(appOpen());
  currentTime = 3000;
  await assert.rejects(supervisor.appOpened(appOpen(3000)), /cleanup failed/);
  assert.equal(supervisor.state(), 'idle');
  assert.throws(() => supervisor.claimShortLivedConnection(), /no ready/);
});

test('起動監督自身は録音、保存、個人資料検索、外部操作を持たない', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('./startup-supervisor.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /RecorderManager|RECORD_AUDIO|writeFile|appendFile|createWriteStream/);
  assert.doesNotMatch(source, /runKnowledgePipeline|runWebResearch|applyConfirmed|child_process/);
  assert.match(source, /executionCapability: 'none'/);
  assert.match(source, /changed: false/);
});
