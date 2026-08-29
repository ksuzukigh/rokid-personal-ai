import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SESSION_SCRIPT = fileURLToPath(new URL('./start-fixed-one-turn-voice-session.mjs', import.meta.url));
const AIUI_PACKAGE = 'com.rokid.os.sprite.assistserver';
const AIUI_SERVICE = 'com.rokid.os.sprite.jsai.JsaiService';
const AIUI_OPEN_ACTION = 'com.rokid.os.sprite.jsai.OPEN_PAGE';
const DAILY_LAUNCHER_PACKAGE = 'io.github.ksuzukigh.rokidpersonalai';
export const DAILY_ONE_TURN_REMOTE_PREFIX =
  '/sdcard/jsai/package/rokid_personal_ai_one_turn_voice_';
export const DEFAULT_ANSWER_DISPLAY_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 65_000;

export function createDailyOneTurnRemotePath(sessionId = randomUUID()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('invalid daily voice session ID');
  }
  return `${DAILY_ONE_TURN_REMOTE_PREFIX}${sessionId.replaceAll('-', '')}.aix`;
}

export function createDailyOneTurnVoiceSession(options = {}) {
  const device = options.device;
  validateDevice(device);
  const output = options.output ?? (() => {});
  const errorOutput = options.errorOutput ?? (() => {});
  const spawnSession = options.spawnSession ?? spawnOneTurnVoiceSession;
  const runAdb = options.runAdb ?? runDeviceAdb;
  const createWork = options.createWork ?? (() => mkdtemp(path.join(tmpdir(), 'rokid-personal-ai-daily-voice-')));
  const removeWork = options.removeWork ?? ((directory) => rm(directory, { recursive: true, force: true }));
  const answerDisplayMs = options.answerDisplayMs ?? DEFAULT_ANSWER_DISPLAY_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const remotePath = createDailyOneTurnRemotePath(options.sessionId);
  if (!Number.isInteger(answerDisplayMs) || answerDisplayMs < 0 || answerDisplayMs > 600_000) {
    throw new Error('invalid answer display interval');
  }
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1000 || readyTimeoutMs > 120_000) {
    throw new Error('invalid voice session readiness timeout');
  }

  let workDirectory = null;
  let child = null;
  let started = false;
  let stopping = false;
  let cleaned = false;
  let completion = null;
  let remoteDeployed = false;
  let deviceCleanupPromise = null;
  let releaseDisplayWait = null;
  let requestAccepted = false;
  let userClosed = false;

  async function start() {
    if (started) throw new Error('daily one-turn voice session is one-shot');
    started = true;
    workDirectory = await createWork();
    const liveAix = path.join(workDirectory, 'live.aix');
    child = spawnSession({ script: SESSION_SCRIPT, outputAix: liveAix, environment: options.environment });
    const childExit = watchChildExit(child);
    childExit.catch(() => {});
    const ready = await waitForSessionReady(child, readyTimeoutMs);
    forwardSafeSessionOutput(child.stdout, output, (line) => {
      if (/^ACCEPTED\b/.test(line)) requestAccepted = true;
      if (/^CLOSED_IDLE\b/.test(line)) {
        userClosed = true;
        // Return the glasses to Home as soon as the user's exit gesture reaches
        // the Mac. Codex session deletion may take longer and must not hold the
        // visible AIX screen open in the meantime.
        void cleanupDeviceOnce();
      }
    });
    forwardSafeSessionOutput(child.stderr, errorOutput);
    if (!existsSync(liveAix)) throw new Error('voice session did not create its AIX');

    await stopAiui(runAdb, device);
    await runAdb(device, ['push', liveAix, remotePath]);
    remoteDeployed = true;
    await openAiui(runAdb, device, remotePath, 'daily-question-ready');
    // The Android activity is only a launch signal. Remove it from beneath the
    // AIX so the RV101 double-tap exit returns to Home instead of resuming the
    // launcher and emitting another app-open event.
    await runAdb(device, ['shell', 'am', 'force-stop', DAILY_LAUNCHER_PACKAGE]);
    output('PERSONAL_AI_QUESTION_SCREEN_READY recordingStarted=false changed=false');

    completion = childExit.then(async (exit) => {
      // Keep either the answer or the visible failure on the glasses long
      // enough to be read. A failed long search must not vanish into Home.
      if (!stopping && !userClosed && requestAccepted && answerDisplayMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            releaseDisplayWait = null;
            resolve();
          }, answerDisplayMs);
          releaseDisplayWait = () => {
            clearTimeout(timer);
            releaseDisplayWait = null;
            resolve();
          };
        });
        releaseDisplayWait = null;
      }
      await cleanupDeviceOnce();
      await cleanupLocal();
      return { ...exit, cleaned: true };
    });
    completion.catch((error) => errorOutput(`PERSONAL_AI_SESSION_CLEANUP_FAILED ${error.message}`));
    return Object.freeze({
      status: 'ready',
      recordingStarted: false,
      changed: false,
      executionCapability: 'none',
      completion,
      publicHealthAttempts: ready.publicHealthAttempts,
    });
  }

  async function stop(reason = 'requested') {
    if (stopping) return completion ?? { stopped: true, reason };
    stopping = true;
    releaseDisplayWait?.();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (completion) {
      await completion.catch(() => {});
    } else {
      await cleanupDeviceOnce();
      await cleanupLocal();
    }
    return { stopped: true, reason };
  }

  async function cleanupLocal() {
    if (cleaned) return;
    cleaned = true;
    if (workDirectory) await removeWork(workDirectory);
    workDirectory = null;
  }

  function cleanupDeviceOnce() {
    if (deviceCleanupPromise) return deviceCleanupPromise;
    if (!remoteDeployed) return Promise.resolve();
    deviceCleanupPromise = cleanupDevice({
      runAdb,
      device,
      remotePath,
      remoteDeployed: true,
      errorOutput,
    }).finally(() => {
      remoteDeployed = false;
    });
    return deviceCleanupPromise;
  }

  return { start, stop };
}

function forwardSafeSessionOutput(stream, output, onLine = () => {}) {
  let buffered = '';
  const allowed = /^(ACCEPTED|SUCCESS|TRANSCRIBE_FAILED|SESSION_RESULT|CLOSED_IDLE)\b/;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (allowed.test(line)) {
        onLine(line);
        output(`PERSONAL_AI_SESSION ${line}`);
      }
    }
  });
  stream.resume();
}

export function spawnOneTurnVoiceSession({ script, outputAix, environment = process.env }) {
  return spawn(process.execPath, [script, outputAix], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runDeviceAdb(device, args) {
  return execFileAsync(device.adbPath, ['-s', device.serial, ...args], {
    env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(device.port) },
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
}

async function stopAiui(runAdb, device) {
  await runAdb(device, ['shell', 'am', 'force-stop', AIUI_PACKAGE]);
}

async function openAiui(runAdb, device, remotePath, runId) {
  await runAdb(device, [
    'shell', 'am', 'startservice',
    '-n', `${AIUI_PACKAGE}/${AIUI_SERVICE}`,
    '-a', AIUI_OPEN_ACTION,
    '--es', 'open_params', remotePath,
    '--es', 'test_run_id', runId,
  ]);
}

async function cleanupDevice({ runAdb, device, remotePath, remoteDeployed, errorOutput }) {
  if (!remoteDeployed) return;
  try {
    await stopAiui(runAdb, device);
    await runAdb(device, ['shell', 'rm', '-f', remotePath]);
    await runAdb(device, ['shell', 'input', 'keyevent', '3']);
  } catch (error) {
    errorOutput(`PERSONAL_AI_DEVICE_CLEANUP_DEFERRED ${error.message}`);
  }
}

function waitForSessionReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => finish(new Error('voice session did not become ready')), timeoutMs);
    const onStdout = (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64 * 1024);
      const match = stdout.match(/SESSION_READY[^\n]*attempts=(\d+)/);
      if (match) finish(null, { publicHealthAttempts: Number(match[1]) });
    };
    const onStderr = (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); };
    const onExit = (code) => finish(new Error(stderr.trim() || `voice session exited before ready: ${code}`));
    const onError = (error) => finish(error);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('close', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('close', onExit);
    child.once('error', onError);
  });
}

function watchChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function validateDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('Rokid device is required');
  if (typeof device.adbPath !== 'string' || !device.adbPath) throw new Error('Rokid ADB path is required');
  if (typeof device.serial !== 'string' || !device.serial) throw new Error('Rokid serial is required');
  if (!Number.isInteger(device.port) || device.port < 1 || device.port > 65535) {
    throw new Error('Rokid ADB port is invalid');
  }
}
