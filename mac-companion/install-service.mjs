import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const SERVICE_LABEL = 'io.github.ksuzukigh.rokid-personal-ai';
const UID = process.getuid?.();
const NODE = '/opt/homebrew/bin/node';
const SERVICE = fileURLToPath(new URL('../daily-gateway/personal-ai-mac-service.mjs', import.meta.url));
const FIXED_ORIGIN = 'personal-ai.example.com';

export function buildLaunchAgentPlist(options = {}) {
  const node = options.node ?? NODE;
  const service = options.service ?? SERVICE;
  const stdout = options.stdout;
  const stderr = options.stderr;
  if (![node, service, stdout, stderr].every((value) => typeof value === 'string' && value.startsWith('/'))) {
    throw new Error('LaunchAgent paths must be absolute');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(service)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LANG</key>
    <string>ja_JP.UTF-8</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderr)}</string>
</dict>
</plist>
`;
}

export async function installService(options = {}) {
  if (!Number.isInteger(UID)) throw new Error('current macOS user is unavailable');
  const home = options.home ?? homedir();
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const logs = path.join(home, 'Library', 'Logs', 'Rokid Personal AI');
  const plist = path.join(launchAgents, `${SERVICE_LABEL}.plist`);
  const domain = `gui/${UID}`;
  await prepareMobileRuntime({ home, ...(options.mobileRuntimeOptions ?? {}) });
  await mkdir(launchAgents, { recursive: true });
  await mkdir(logs, { recursive: true });
  await bootout(domain, plist, options.run ?? runLaunchctl);
  await writeFile(plist, buildLaunchAgentPlist({
    stdout: path.join(logs, 'service.log'),
    stderr: path.join(logs, 'service-error.log'),
  }), { encoding: 'utf8', mode: 0o600 });
  await chmod(plist, 0o600);
  const run = options.run ?? runLaunchctl;
  await run(['bootstrap', domain, plist]);
  await run(['kickstart', '-k', `${domain}/${SERVICE_LABEL}`]);
  return { installed: true, label: SERVICE_LABEL, plist, logs };
}

export function buildMobileTunnelConfig(source) {
  const tunnel = String(source).match(/^tunnel:\s*([^\s#]+)\s*$/m)?.[1];
  const credentials = String(source).match(/^\s*credentials-file:\s*(.+?)\s*$/m)?.[1];
  if (!tunnel || !credentials || !credentials.startsWith('/')) {
    throw new Error('existing Personal AI Cloudflare configuration is invalid');
  }
  return `tunnel: ${tunnel}
credentials-file: ${credentials}

ingress:
  - hostname: ${FIXED_ORIGIN}
    path: /v1/bootstrap
    service: http://127.0.0.1:18447
  - hostname: ${FIXED_ORIGIN}
    path: /v1/status
    service: http://127.0.0.1:18447
  - hostname: ${FIXED_ORIGIN}
    service: http://127.0.0.1:18448
  - service: http_status:404
`;
}

export async function prepareMobileRuntime(options = {}) {
  const home = options.home ?? homedir();
  const configDirectory = path.join(home, '.config', 'rokid-personal-ai');
  const cloudflareDirectory = path.join(home, '.cloudflared');
  const tokenFile = options.tokenFile ?? path.join(configDirectory, 'bootstrap-token');
  const sourceConfig = options.sourceConfig ?? path.join(cloudflareDirectory, 'rokid-personal-ai.yml');
  const mobileConfig = options.mobileConfig ?? path.join(cloudflareDirectory, 'rokid-personal-ai-mobile.yml');
  await mkdir(configDirectory, { recursive: true });
  let token = '';
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (Buffer.byteLength(token, 'utf8') < 32) {
    token = randomBytes(32).toString('hex');
    await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  await chmod(tokenFile, 0o600);
  const source = await readFile(sourceConfig, 'utf8');
  await writeFile(mobileConfig, buildMobileTunnelConfig(source), { encoding: 'utf8', mode: 0o600 });
  await chmod(mobileConfig, 0o600);
  return { tokenFile, mobileConfig };
}

export async function uninstallService(options = {}) {
  if (!Number.isInteger(UID)) throw new Error('current macOS user is unavailable');
  const home = options.home ?? homedir();
  const plist = path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  await bootout(`gui/${UID}`, plist, options.run ?? runLaunchctl);
  await rm(plist, { force: true });
  return { installed: false, label: SERVICE_LABEL, plist };
}

async function bootout(domain, plist, run) {
  await run(['bootout', domain, plist], { tolerateFailure: true });
}

async function runLaunchctl(args, options = {}) {
  try {
    return await execFileAsync('/bin/launchctl', args, { timeout: 15_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    if (options.tolerateFailure) return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    throw error;
  }
}

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = process.argv.includes('--uninstall')
      ? await uninstallService()
      : await installService();
    console.log(`${result.installed ? 'INSTALLED' : 'UNINSTALLED'} ${result.label}`);
  } catch (error) {
    console.error(`SERVICE_SETUP_FAILED ${error.message}`);
    process.exitCode = 2;
  }
}
