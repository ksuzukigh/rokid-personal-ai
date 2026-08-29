import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXED_DAILY_ORIGIN } from './fixed-session-controller.mjs';
import { normalizeDailyUtterance } from './session-receiver.mjs';

export function prepareRouteAix(outputArgument, options = {}) {
  if (!outputArgument) throw new Error('output path is required');
  const origin = options.origin ?? '';
  const token = options.token ?? '';
  const utterance = normalizeDailyUtterance(options.utterance);
  if (origin !== FIXED_DAILY_ORIGIN) throw new Error('route AIX requires the fixed private origin');
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('route AIX token must be at least 32 bytes');
  }

  const output = path.resolve(outputArgument);
  const work = mkdtempSync(path.join(tmpdir(), 'rokid-personal-ai-route-aix-'));
  const source = path.join(import.meta.dirname, 'aiui-route-source');
  try {
    mkdirSync(path.join(work, 'pages/index'), { recursive: true });
    cpSync(path.join(source, 'app.js'), path.join(work, 'app.js'));
    cpSync(path.join(source, 'app.json'), path.join(work, 'app.json'));
    let page = readFileSync(path.join(source, 'pages/index/index.ink'), 'utf8');
    page = replaceOnce(page, '__ROUTE_URL__', `${origin}/v1/route`);
    page = replaceOnce(page, '__CANCEL_URL__', `${origin}/v1/cancel`);
    page = replaceOnce(page, '__SESSION_TOKEN__', token);
    page = replaceOnce(page, '__UTTERANCE_JSON__', JSON.stringify(utterance));
    writeFileSync(path.join(work, 'pages/index/index.ink'), page, { mode: 0o600 });
    writeFileSync(path.join(work, 'AGENTS.md'), [
      '# Agent: 私のAI 行き先確認', '',
      '- 録音なしの指定文字一件をMacへ送り、行き先だけを表示する。',
      '- 録音、個人知識検索、Web検索、保存、書き込み、外部操作を禁止する。',
      '- 応答は実行能力なし、変更なしの場合だけ採用する。', ''
    ].join('\n'), { mode: 0o600 });
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({
      name: 'rokid-personal-ai-route-preview',
      version: '0.1.0-test',
      private: true,
      description: 'One-shot route-only preview without recording or downstream execution',
      main: 'app.js',
      dependencies: {}
    }, null, 2), { mode: 0o600 });
    writeFileSync(path.join(work, 'VERSION'), `${randomUUID()}\n`, { mode: 0o600 });
    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });
    execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: work });
    chmodSync(output, 0o600);
    return output;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function replaceOnce(source, expected, replacement) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`expected exactly one route AIX placeholder: ${expected}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = prepareRouteAix(process.argv[2], {
      origin: process.env.ROKID_DAILY_ORIGIN,
      token: process.env.ROKID_DAILY_SESSION_TOKEN,
      utterance: process.env.ROKID_DAILY_UTTERANCE,
    });
    console.log(`READY ${output}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
