import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [outputArgument] = process.argv.slice(2);
const origin = process.env.ROKID_VOICE_NOTE_ORIGIN || '';
const token = process.env.ROKID_VOICE_NOTE_TOKEN || '';
const previewOnly = process.env.ROKID_VOICE_NOTE_PREVIEW_ONLY === '1';
const fixedOrigin = 'https://personal-ai.example.com';
const source = resolve(import.meta.dirname, '../aiui-knowledge-bridge/voice-aix-source');
const pageSource = resolve(import.meta.dirname, 'voice-note-aix-source/pages/index/index.ink');

if (!outputArgument) fail('usage: node prepare-voice-note-aix.mjs OUTPUT_AIX');
if (!previewOnly && origin !== fixedOrigin) fail('origin must be the fixed Cloudflare hostname');
if (!previewOnly && Buffer.byteLength(token, 'utf8') < 32) fail('token must be at least 32 bytes');
if (previewOnly && (origin || token)) fail('preview-only package must not contain a destination or token');

const output = resolve(outputArgument);
const work = mkdtempSync(join(tmpdir(), 'rokid-voice-note-aix-'));
try {
  mkdirSync(join(work, 'pages/index'), { recursive: true });
  mkdirSync(join(work, 'lib'), { recursive: true });
  cpSync(join(source, 'app.js'), join(work, 'app.js'));
  cpSync(join(source, 'lib/one-shot-audio.mjs'), join(work, 'lib/one-shot-audio.mjs'));
  let page = readFileSync(pageSource, 'utf8');
  if (!previewOnly) {
    page = replaceOnce(page, "const AUDIO_URL = '';", `const AUDIO_URL = '${origin}/v1/transcribe';`);
    page = replaceOnce(page, "const CANCEL_URL = '';", `const CANCEL_URL = '${origin}/v1/cancel';`);
    page = replaceOnce(page, "const CONFIRM_URL = '';", `const CONFIRM_URL = '${origin}/v1/confirm-note';`);
    page = replaceOnce(page, "const NOTE_CANCEL_URL = '';", `const NOTE_CANCEL_URL = '${origin}/v1/cancel-note';`);
    page = replaceOnce(page, "const AUTH_TOKEN = '';", `const AUTH_TOKEN = '${token}';`);
  }
  page = replaceOnce(page, "const TEST_LABEL = '';", "const TEST_LABEL = '音声メモ';");
  page = replaceOnce(page, 'const CONFIRMATION_TIMEOUT_MS = 15000;', 'const CONFIRMATION_TIMEOUT_MS = 120000;');
  page = replaceOnce(page, '<text class="title">一回音声入力テスト</text>', '<text class="title">音声をObsidianへメモ</text>');
  writeFileSync(join(work, 'pages/index/index.ink'), page, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'AGENTS.md'), [
    '# Agent: Rokid一回音声メモ', '',
    '- 明示操作後の一回だけ、16kHz・モノラルPCMをMacへ送る。',
    '- Mac内Whisperの認識結果を表示し、利用者の確認後だけ試用メモへ一件追記する。',
    '- AIによる要約・言い換え、Web検索、二回目の録音は行わない。', ''
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(work, 'app.json'), JSON.stringify({ pages: ['pages/index/index'], window: { navigationBarTitleText: '音声メモ' } }, null, 2), { mode: 0o600 });
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'rokid-one-shot-voice-note', version: '0.1.0-test', private: true }, null, 2), { mode: 0o600 });
  writeFileSync(join(work, 'VERSION'), `${randomUUID()}\n`, { mode: 0o600 });
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: work });
  chmodSync(output, 0o600);
  console.log(`READY ${output}`);
} finally { rmSync(work, { recursive: true, force: true }); }

function replaceOnce(value, expected, replacement) {
  const first = value.indexOf(expected);
  if (first < 0 || value.indexOf(expected, first + expected.length) >= 0) fail(`expected exactly one match: ${expected}`);
  return value.slice(0, first) + replacement + value.slice(first + expected.length);
}
function fail(message) { console.error(message); process.exit(2); }
