import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXED_DAILY_ORIGIN } from './fixed-session-controller.mjs';
import { normalizeOneTurnRequest } from './one-turn-agent.mjs';

export function prepareOneTurnAix(outputArgument, options = {}) {
  if (!outputArgument) throw new Error('output path is required');
  const origin = options.origin ?? '';
  const token = options.token ?? '';
  const request = normalizeOneTurnRequest(options.request);
  if (origin !== FIXED_DAILY_ORIGIN) throw new Error('one-turn AIX requires the fixed private origin');
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('one-turn AIX token must be at least 32 bytes');
  }

  const output = path.resolve(outputArgument);
  const work = mkdtempSync(path.join(tmpdir(), 'rokid-personal-ai-one-turn-aix-'));
  const source = path.join(import.meta.dirname, 'aiui-one-turn-source');
  try {
    mkdirSync(path.join(work, 'pages/index'), { recursive: true });
    cpSync(path.join(source, 'app.js'), path.join(work, 'app.js'));
    cpSync(path.join(source, 'app.json'), path.join(work, 'app.json'));
    let page = readFileSync(path.join(source, 'pages/index/index.ink'), 'utf8');
    page = replaceOnce(page, '__ANSWER_URL__', `${origin}/v1/answer`);
    page = replaceOnce(page, '__CANCEL_URL__', `${origin}/v1/cancel`);
    page = replaceOnce(page, '__SESSION_TOKEN__', token);
    page = replaceOnce(page, '__FREE_REQUEST_JSON__', JSON.stringify(request));
    writeFileSync(path.join(work, 'pages/index/index.ink'), page, { mode: 0o600 });
    writeFileSync(path.join(work, 'AGENTS.md'), [
      '# Agent: 私のAI 会話表示', '',
      '- 指定した利用者の発言をMacへ送り、私とAIの役割が分かる形で応答を表示する。',
      '- 固定コマンドや固定分類へ当てはめない。',
      '- 録音、保存、書き込み、送信、削除、外部変更を行わない。', ''
    ].join('\n'), { mode: 0o600 });
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({
      name: 'rokid-personal-ai-one-turn',
      version: '0.1.0-test',
      private: true,
      description: 'One-shot free request and read-only answer display',
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
    throw new Error(`expected exactly one one-turn AIX placeholder: ${expected}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = prepareOneTurnAix(process.argv[2], {
      origin: process.env.ROKID_DAILY_ORIGIN,
      token: process.env.ROKID_DAILY_SESSION_TOKEN,
      request: process.env.ROKID_DAILY_REQUEST,
    });
    console.log(`READY ${output}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
