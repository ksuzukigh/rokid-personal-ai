import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAILY_APP_AGENT_ID = '904a3a9b0491e23ec1e4b5f8e4f25d0a';
export const DAILY_APP_REMOTE_PATH = `/sdcard/jsai/package/${DAILY_APP_AGENT_ID}.aix`;
export const DAILY_APP_VERSION = 'daily-entry-v0.22.1';

export function buildDailyAppAix(outputArgument, options = {}) {
  if (!outputArgument) throw new Error('output path is required');
  const output = path.resolve(outputArgument);
  const work = mkdtempSync(path.join(tmpdir(), 'rokid-personal-ai-daily-'));
  try {
    mkdirSync(path.join(work, 'pages/index'), { recursive: true });
    cpSync(path.join(import.meta.dirname, 'app.js'), path.join(work, 'app.js'));
    cpSync(path.join(import.meta.dirname, 'app.json'), path.join(work, 'app.json'));
    cpSync(path.join(import.meta.dirname, 'pages/index/index.ink'), path.join(work, 'pages/index/index.ink'));
    writeFileSync(path.join(work, 'AGENTS.md'), [
      '# Agent: 私のAI', '',
      '- RV101から一つの入口として日常起動する。',
      '- 固定メニューを表示せず、利用者が自然に話せるまでの準備画面だけを表示する。',
      '- この画面自体は録音、通信、保存、書き込み、外部操作を行わない。',
      '- アイコン画像を含めない。', ''
    ].join('\n'), { mode: 0o600 });
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({
      name: 'rokid-personal-ai-daily-entry', version: '0.1.0-test', private: true,
      description: 'Side-effect-free preparation screen for Rokid Personal AI', main: 'app.js', dependencies: {}
    }, null, 2), { mode: 0o600 });
    const version = options.version ?? randomUUID();
    if (typeof version !== 'string' || !version.trim() || /[\r\n]/.test(version)) {
      throw new Error('daily AIX version is invalid');
    }
    writeFileSync(path.join(work, 'VERSION'), `${version}\n`, { mode: 0o600 });
    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });
    execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: work });
    chmodSync(output, 0o600);
    return output;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`READY ${buildDailyAppAix(process.argv[2])}`); }
  catch (error) { console.error(error.message); process.exit(2); }
}
