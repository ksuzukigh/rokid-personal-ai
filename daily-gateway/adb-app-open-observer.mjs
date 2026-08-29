import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { DAILY_APP_OPEN_EVENT } from './startup-supervisor.mjs';

const execFileAsync = promisify(execFile);
export const APP_OPEN_LOG_TAG = 'RokidPersonalAI';
export const APP_OPEN_LOG_EVENT = 'DAILY_APP_OPENED';
export const DEFAULT_ROKID_ADB = '/opt/homebrew/bin/adb';
export const DEFAULT_ROKID_ADB_PORT = 5042;
const EVENT_PATTERN = /^DAILY_APP_OPENED eventId=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function parseAppOpenEventId(line) {
  if (typeof line !== 'string') return null;
  return line.trim().match(EVENT_PATTERN)?.[1]?.toLowerCase() ?? null;
}

export function createAdbAppOpenObserver(options = {}) {
  const now = options.now ?? Date.now;
  const onAppOpened = options.onAppOpened;
  const onError = options.onError ?? (() => {});
  const readExisting = options.readExisting ?? readExistingAppOpenLogs;
  const startLogcat = options.startLogcat ?? startAppOpenLogcat;
  if (typeof now !== 'function' || typeof onAppOpened !== 'function') {
    throw new Error('app-open observer dependencies are required');
  }

  let logcat = null;
  let handling = Promise.resolve();
  let stopped = false;
  const seen = new Set();

  function remember(eventId) {
    seen.add(eventId);
    if (seen.size > 256) seen.delete(seen.values().next().value);
  }

  function handleLine(line) {
    const eventId = parseAppOpenEventId(line);
    if (!eventId || seen.has(eventId) || stopped) return;
    remember(eventId);
    handling = handling
      .then(() => onAppOpened({ type: DAILY_APP_OPEN_EVENT, observedAt: now() }))
      .catch((error) => onError(error));
  }

  async function start() {
    if (logcat || stopped) throw new Error('app-open observer is one-shot');
    const existingLines = await readExisting(options);
    for (const line of existingLines) {
      const eventId = parseAppOpenEventId(line);
      if (eventId) remember(eventId);
    }
    logcat = await startLogcat({ ...options, onLine: handleLine });
    Promise.resolve(logcat.completion).catch(onError);
    return { ready: true, completion: Promise.resolve(logcat.completion) };
  }

  async function stop() {
    if (stopped) return { stopped: true };
    stopped = true;
    await logcat?.stop?.();
    await handling;
    return { stopped: true };
  }

  return { start, stop };
}

export async function readExistingAppOpenLogs(options = {}) {
  const adbPath = options.adbPath ?? DEFAULT_ROKID_ADB;
  const serial = options.serial;
  const port = options.port ?? DEFAULT_ROKID_ADB_PORT;
  validateAdbOptions({ adbPath, serial, port });
  const { stdout } = await execFileAsync(adbPath, [
    '-s', serial, 'logcat', '-d', '-v', 'raw', '-s', `${APP_OPEN_LOG_TAG}:I`, '*:S',
  ], { env: adbEnvironment(port, options.environment), maxBuffer: 64 * 1024 });
  return stdout.split(/\r?\n/);
}

export async function startAppOpenLogcat(options = {}) {
  const adbPath = options.adbPath ?? DEFAULT_ROKID_ADB;
  const serial = options.serial;
  const port = options.port ?? DEFAULT_ROKID_ADB_PORT;
  const onLine = options.onLine;
  validateAdbOptions({ adbPath, serial, port });
  if (typeof onLine !== 'function') throw new Error('logcat line handler is required');

  const child = spawn(adbPath, [
    '-s', serial, 'logcat', '-v', 'raw', '-s', `${APP_OPEN_LOG_TAG}:I`, '*:S',
  ], {
    env: adbEnvironment(port, options.environment),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', onLine);
  let closed = false;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      lines.close();
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') resolve({ code, signal });
      else reject(new Error(`Rokid app-open logcat stopped: ${code ?? signal}`));
    });
  });
  completion.catch(() => {});
  return {
    completion,
    async stop() {
      if (closed) return;
      child.kill('SIGTERM');
      await completion;
    },
  };
}

function validateAdbOptions({ adbPath, serial, port }) {
  if (!adbPath || !existsSync(adbPath)) throw new Error('Personal AI ADB not found');
  if (typeof serial !== 'string' || !serial.trim()) throw new Error('Rokid ADB serial is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid Rokid ADB port');
}

function adbEnvironment(port, source = process.env) {
  return { ...source, ANDROID_ADB_SERVER_PORT: String(port) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('Use start-daily-app-supervisor.mjs to run the observer with the safe session supervisor.');
  process.exitCode = 2;
}
