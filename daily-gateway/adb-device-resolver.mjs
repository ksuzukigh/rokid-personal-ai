import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import {
  DEFAULT_ROKID_ADB,
  DEFAULT_ROKID_ADB_PORT,
} from './adb-app-open-observer.mjs';

const execFileAsync = promisify(execFile);
const BONJOUR_TYPE = '_adb-tls-connect._tcp';

export function parseAdbDevices(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\S+)\s+device(?:\s|$)/)?.[1] ?? null)
    .filter(Boolean);
}

export function parseAdbMdnsServices(output) {
  const endpoints = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const index = fields.indexOf(BONJOUR_TYPE);
    const endpoint = index >= 0 ? fields[index + 1] : null;
    if (endpoint && /^(?:[A-Za-z0-9.-]+|\[[0-9a-f:]+\]):\d{1,5}$/i.test(endpoint)) {
      endpoints.push(endpoint);
    }
  }
  return [...new Set(endpoints)];
}

export function parseBonjourBrowse(output) {
  const names = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const marker = `${BONJOUR_TYPE}.`;
    const index = line.indexOf(marker);
    if (index < 0 || !/\bAdd\b/.test(line.slice(0, index))) continue;
    const name = line.slice(index + marker.length).trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

export function parseBonjourLookup(output) {
  const match = String(output ?? '').match(/can be reached at\s+([^\s:]+(?:\.[^\s:]*)?):(\d{1,5})/i);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return `${match[1]}:${port}`;
}

export async function resolveRokidDevice(options = {}) {
  const adbPath = options.adbPath ?? DEFAULT_ROKID_ADB;
  const port = options.port ?? DEFAULT_ROKID_ADB_PORT;
  const environment = options.environment ?? process.env;
  const runAdb = options.runAdb ?? ((args, commandOptions = {}) => runAdbCommand({
    adbPath,
    port,
    environment,
    args,
    ...commandOptions,
  }));
  const browseBonjour = options.browseBonjour ?? (() => discoverBonjourEndpoints(options));
  if (!existsSync(adbPath) && !options.runAdb) throw new Error('Personal AI ADB not found');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid Personal AI ADB port');

  await runAdb(['start-server']);
  let serial = await findVerifiedDevice(runAdb);
  if (serial) return { serial, adbPath, port, discovery: 'connected' };

  const mdns = await runAdb(['mdns', 'services'], { tolerateFailure: true });
  let endpoints = parseAdbMdnsServices(mdns.stdout);
  let discovery = 'adb-mdns';
  if (!endpoints.length) {
    endpoints = await browseBonjour();
    discovery = 'bonjour';
  }
  for (const endpoint of endpoints) {
    await runAdb(['connect', endpoint], { tolerateFailure: true });
  }
  serial = await findVerifiedDevice(runAdb);
  if (!serial) throw new Error('Rokid AI Glasses is not reachable');
  return { serial, adbPath, port, discovery };
}

async function findVerifiedDevice(runAdb) {
  const devices = parseAdbDevices((await runAdb(['devices', '-l'])).stdout);
  for (const serial of devices) {
    const result = await runAdb([
      '-s', serial, 'shell', 'getprop', 'ro.product.model',
    ], { tolerateFailure: true });
    const model = result.stdout.trim().replaceAll('_', '-').toLowerCase();
    if (model === 'rg-glasses') return serial;
  }
  return null;
}

async function runAdbCommand({ adbPath, port, environment, args, tolerateFailure = false }) {
  try {
    const result = await execFileAsync(adbPath, args, {
      env: { ...environment, ANDROID_ADB_SERVER_PORT: String(port) },
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (tolerateFailure) return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    throw error;
  }
}

export async function discoverBonjourEndpoints(options = {}) {
  const dnsSdPath = options.dnsSdPath ?? '/usr/bin/dns-sd';
  const browseMs = options.browseMs ?? 2500;
  const lookupMs = options.lookupMs ?? 1500;
  const capture = options.captureProcess ?? captureProcess;
  if (!existsSync(dnsSdPath) && !options.captureProcess) return [];
  const browse = await capture(dnsSdPath, ['-B', BONJOUR_TYPE, 'local'], browseMs);
  const endpoints = [];
  for (const name of parseBonjourBrowse(browse)) {
    const lookup = await capture(dnsSdPath, ['-L', name, BONJOUR_TYPE, 'local'], lookupMs);
    const endpoint = parseBonjourLookup(lookup);
    if (endpoint) endpoints.push(endpoint);
  }
  return [...new Set(endpoints)];
}

function captureProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk) => { output = `${output}${chunk}`.slice(-64 * 1024); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

export async function stopPersonalAiAdbServer(options = {}) {
  const adbPath = options.adbPath ?? DEFAULT_ROKID_ADB;
  const port = options.port ?? DEFAULT_ROKID_ADB_PORT;
  if (!existsSync(adbPath)) return;
  await execFileAsync(adbPath, ['kill-server'], {
    env: { ...(options.environment ?? process.env), ANDROID_ADB_SERVER_PORT: String(port) },
    timeout: 5000,
    maxBuffer: 64 * 1024,
  }).catch(() => {});
}
