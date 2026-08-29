import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDailyOneTurnRemotePath,
  createDailyOneTurnVoiceSession,
  DAILY_ONE_TURN_REMOTE_PREFIX,
} from './daily-one-turn-voice-session.mjs';

const sessionId = '11111111-2222-4333-8444-555555555555';
const remotePath = `${DAILY_ONE_TURN_REMOTE_PREFIX}${sessionId.replaceAll('-', '')}.aix`;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;

  finish(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => this.finish(null, signal));
    return true;
  }
}

const device = {
  adbPath: '/opt/homebrew/bin/adb',
  serial: 'Android.local.:34383',
  port: 5042,
};

test('通常入口の合図から録音せず質問画面を開き、終了後は通信情報を消す', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'daily-one-turn-session-test-'));
  const child = new FakeChild();
  const adbCalls = [];
  const outputs = [];
  const errorOutputs = [];
  const session = createDailyOneTurnVoiceSession({
    device,
    sessionId,
    createWork: async () => work,
    removeWork: async () => {},
    spawnSession({ outputAix }) {
      void writeFile(outputAix, 'live').then(() => {
        child.stdout.write('SESSION_READY transport=cloudflare-named attempts=3\n');
      });
      return child;
    },
    async runAdb(_device, args) {
      adbCalls.push(args);
      return { stdout: '', stderr: '' };
    },
    answerDisplayMs: 0,
    output: (line) => outputs.push(line),
    errorOutput: (line) => errorOutputs.push(line),
  });
  try {
    const ready = await session.start();
    assert.equal(ready.recordingStarted, false);
    assert.equal(ready.changed, false);
    assert.equal(ready.publicHealthAttempts, 3);
    assert.match(outputs.join('\n'), /QUESTION_SCREEN_READY recordingStarted=false/);
    assert.deepEqual(adbCalls[0], ['shell', 'am', 'force-stop', 'com.rokid.os.sprite.assistserver']);
    assert.deepEqual(adbCalls[1], ['push', path.join(work, 'live.aix'), remotePath]);
    assert.equal(adbCalls[2].includes('startservice'), true);
    assert.deepEqual(adbCalls[3], [
      'shell', 'am', 'force-stop', 'io.github.ksuzukigh.rokidpersonalai',
    ]);
    assert.equal(adbCalls.flat().includes('input'), false);
    assert.equal(adbCalls.flat().includes('record'), false);

    child.stdout.write('ACCEPTED requestId=voice_test_01 bytes=400000 count=1/unlimited\n');
    child.stdout.write('TRANSCRIPT これは保存・転送しない\n');
    child.stderr.write('TRANSCRIBE_FAILED requestId=voice_test_01 error=test_failure\n');
    assert.match(outputs.join('\n'), /PERSONAL_AI_SESSION ACCEPTED .*bytes=400000/);
    assert.doesNotMatch(outputs.join('\n'), /TRANSCRIPT|これは保存/);
    assert.match(errorOutputs.join('\n'), /PERSONAL_AI_SESSION TRANSCRIBE_FAILED .*test_failure/);

    child.finish(0);
    const completed = await ready.completion;
    assert.equal(completed.cleaned, true);
    assert.equal(adbCalls.some((args) => args[0] === 'push' && args[1].endsWith('safe.aix')), false);
    assert.equal(adbCalls.some((args) => args.includes('daily-question-cleanup')), false);
    assert.equal(adbCalls.some((args) =>
      args.join(' ') === `shell rm -f ${remotePath}`), true);
    assert.deepEqual(adbCalls.at(-1), ['shell', 'input', 'keyevent', '3']);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('回答後に利用者が画面を閉じたら表示待ちをせず後片付けする', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'daily-one-turn-idle-close-test-'));
  const child = new FakeChild();
  const adbCalls = [];
  let homeReleased;
  const homeRelease = new Promise((resolve) => { homeReleased = resolve; });
  const closeSessionId = '55555555-5555-4555-8555-555555555555';
  const closeRemotePath = createDailyOneTurnRemotePath(closeSessionId);
  const session = createDailyOneTurnVoiceSession({
    device,
    sessionId: closeSessionId,
    createWork: async () => work,
    removeWork: async () => {},
    spawnSession({ outputAix }) {
      void writeFile(outputAix, 'live').then(() => {
        child.stdout.write('SESSION_READY transport=cloudflare-named attempts=1\n');
      });
      return child;
    },
    async runAdb(_device, args) {
      adbCalls.push(args);
      if (args.join(' ') === 'shell input keyevent 3') homeReleased();
      return { stdout: '', stderr: '' };
    },
    answerDisplayMs: 120_000,
  });
  try {
    const ready = await session.start();
    child.stdout.write('ACCEPTED requestId=voice_test_close bytes=32000 count=1/unlimited\n');
    child.stdout.write('SUCCESS requestId=voice_test_close elapsedMs=1000\n');
    child.stdout.write('CLOSED_IDLE requestId=close-idle-session accepted=1\n');
    await homeRelease;
    assert.equal(child.exitCode, null, 'Codex側の終了を待たずRokidをHomeへ戻す');
    assert.equal(adbCalls.some((args) => args.join(' ') === `shell rm -f ${closeRemotePath}`), true);
    child.finish(0);
    const completed = await ready.completion;
    assert.equal(completed.cleaned, true);
    assert.equal(adbCalls.filter((args) => args.join(' ') === `shell rm -f ${closeRemotePath}`).length, 1);
    assert.equal(adbCalls.filter((args) => args.join(' ') === 'shell input keyevent 3').length, 1);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('Mac側を止めると待機中の一回セッションも終了して後片付けする', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'daily-one-turn-stop-test-'));
  const child = new FakeChild();
  const adbCalls = [];
  const session = createDailyOneTurnVoiceSession({
    device,
    sessionId,
    createWork: async () => work,
    removeWork: async () => {},
    spawnSession({ outputAix }) {
      void writeFile(outputAix, 'live').then(() => {
        child.stdout.write('SESSION_READY transport=cloudflare-named attempts=1\n');
      });
      return child;
    },
    async runAdb(_device, args) {
      adbCalls.push(args);
      return { stdout: '', stderr: '' };
    },
    answerDisplayMs: 120_000,
  });
  try {
    await session.start();
    await session.stop('test');
    assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(adbCalls.some((args) =>
      args.join(' ') === `shell rm -f ${remotePath}`), true);
    assert.deepEqual(adbCalls.at(-1), ['shell', 'input', 'keyevent', '3']);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('質問画面はセッションごとに別名にしてYodaOSの古いキャッシュを再利用しない', () => {
  const first = createDailyOneTurnRemotePath();
  const second = createDailyOneTurnRemotePath();
  assert.notEqual(first, second);
  assert.match(first, /^\/sdcard\/jsai\/package\/rokid_personal_ai_one_turn_voice_[0-9a-f]{32}\.aix$/);
  assert.throws(() => createDailyOneTurnRemotePath('not-a-session'), /invalid daily voice session ID/);
});

test('受領後の回答処理が失敗しても結果画面を読める間は消さない', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'daily-one-turn-failure-display-test-'));
  const child = new FakeChild();
  const adbCalls = [];
  const failureSessionId = '44444444-4444-4444-8444-444444444444';
  const failureRemotePath = createDailyOneTurnRemotePath(failureSessionId);
  const session = createDailyOneTurnVoiceSession({
    device,
    sessionId: failureSessionId,
    createWork: async () => work,
    removeWork: async () => {},
    spawnSession({ outputAix }) {
      void writeFile(outputAix, 'live').then(() => {
        child.stdout.write('SESSION_READY transport=cloudflare-named attempts=1\n');
      });
      return child;
    },
    async runAdb(_device, args) {
      adbCalls.push(args);
      return { stdout: '', stderr: '' };
    },
    answerDisplayMs: 120_000,
  });
  try {
    const ready = await session.start();
    child.stdout.write('ACCEPTED requestId=voice_test_failure bytes=32000 count=1/1\n');
    child.stderr.write('TRANSCRIBE_FAILED requestId=voice_test_failure error=search_timeout\n');
    child.finish(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adbCalls.some((args) => args.join(' ') === `shell rm -f ${failureRemotePath}`), false);
    await session.stop('test-release-failure-display');
    await ready.completion;
    assert.equal(adbCalls.some((args) => args.join(' ') === `shell rm -f ${failureRemotePath}`), true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
