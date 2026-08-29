import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [outputArgument] = process.argv.slice(2);
const origin = process.env.ROKID_VOICE_KNOWLEDGE_ORIGIN || '';
const token = process.env.ROKID_VOICE_KNOWLEDGE_TOKEN || '';
const previewOnly = process.env.ROKID_VOICE_KNOWLEDGE_PREVIEW_ONLY === '1';
const processingPreviewOnly = process.env.ROKID_ONE_TURN_PROCESSING_PREVIEW_ONLY === '1';
const oneTurnMode = process.env.ROKID_ONE_TURN_VOICE === '1';
const fixedOrigin = 'https://personal-ai.example.com';
const source = resolve(import.meta.dirname, 'voice-aix-source');

if (!outputArgument) fail('usage: node prepare-voice-aix.mjs OUTPUT_AIX');
if (!previewOnly && origin !== fixedOrigin) fail('origin must be the fixed Cloudflare hostname');
if (!previewOnly && Buffer.byteLength(token, 'utf8') < 32) fail('token must be at least 32 bytes');
if (previewOnly && (origin || token)) fail('preview-only package must not contain a destination or token');
if (processingPreviewOnly && (!previewOnly || !oneTurnMode)) fail('processing preview requires one-turn preview-only mode');

const output = resolve(outputArgument);
const work = mkdtempSync(join(tmpdir(), 'rokid-aiui-voice-knowledge-aix-'));

try {
  mkdirSync(join(work, 'pages/index'), { recursive: true });
  mkdirSync(join(work, 'lib'), { recursive: true });
  cpSync(join(source, 'app.js'), join(work, 'app.js'));

  let page = readFileSync(join(source, 'pages/index/index.ink'), 'utf8');
  let audioModule = readFileSync(join(source, 'lib/one-shot-audio.mjs'), 'utf8');
  if (!previewOnly) {
    page = replaceOnce(page, "const AUDIO_URL = '';", `const AUDIO_URL = '${origin}/v1/transcribe';`);
    page = replaceOnce(page, "const CANCEL_URL = '';", `const CANCEL_URL = '${origin}/v1/cancel';`);
    if (oneTurnMode) {
      page = replaceOnce(page, "const EFFECT_CONFIRM_URL = '';", `const EFFECT_CONFIRM_URL = '${origin}/v1/confirm-effect';`);
      page = replaceOnce(page, "const EFFECT_CANCEL_URL = '';", `const EFFECT_CANCEL_URL = '${origin}/v1/cancel-effect';`);
    }
    page = replaceOnce(page, "const AUTH_TOKEN = '';", `const AUTH_TOKEN = '${token}';`);
  }
  page = replaceOnce(page, "const TEST_LABEL = '';", "const TEST_LABEL = 'どうぞ';");
  page = replaceOnce(page, 'const EVALUATION_ONLY = false;', 'const EVALUATION_ONLY = true;');
  if (processingPreviewOnly) {
    page = replaceOnce(page, 'const PROCESSING_PREVIEW_ONLY = false;', 'const PROCESSING_PREVIEW_ONLY = true;');
  }
  if (oneTurnMode) {
    page = replaceOneTurnAudioLimits(page);
    audioModule = replaceOneTurnAudioLimits(audioModule);
    page = replaceOnce(page, 'const ALLOW_REPEAT = false;', 'const ALLOW_REPEAT = true;');
    page = replaceOnce(page, 'const CODEX_CONVERSATION_MODE = false;', 'const CODEX_CONVERSATION_MODE = true;');
  }
  writeFileSync(join(work, 'pages/index/index.ink'), page, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'lib/one-shot-audio.mjs'), audioModule, { encoding: 'utf8', mode: 0o600 });

  writeFileSync(join(work, 'AGENTS.md'), [
    oneTurnMode ? '# Agent: 私のAI Codex継続会話' : '# Agent: Rokid個人AI自由発話テスト',
    '',
    '- Version: 0.1.0-test',
    oneTurnMode
      ? '- 発言ごとの明示操作後だけ、16kHz・モノラルPCMをMacへ送る。'
      : '- 明示操作後の一回だけ、16kHz・モノラルPCMをMacへ送る。',
    oneTurnMode
      ? '- 無音では終了せず、利用者の終了操作または最長60秒で停止し、上限は1,920,000バイト。'
      : '- 発話後900msの無音または最長10秒で停止し、上限は320,000バイト。',
    oneTurnMode
      ? '- Mac内Whisperで文字化し、同じCodex作業のAIが発言を依頼または質問として自由に解釈する。'
      : '- Mac内Whisperと読み取り専用の個人知識経路だけを使い、利用者の発言とAIの応答を役割別に表示する。',
    oneTurnMode
      ? '- AIが確認したいことは画面に返し、利用者の次の発言を同じCodex作業の続きとして渡す。'
      : '- 保存、書き込み、外部操作、二回目の録音を禁止する。',
    oneTurnMode
      ? '- 原音は処理後に削除し、文字の「私」・「AI」・会話参照の有無をObsidianの日付別会話記録へ追記する。'
      : '',
    oneTurnMode
      ? '- 許可済み範囲の保存・編集候補は対象と内容を表示し、利用者の別の1回操作をMac側の共通実行境界へ渡す。このAIX自体はファイルを変更しない。'
      : '',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(
    join(work, 'README.md'),
    oneTurnMode
      ? '自由発話をMac内で文字化し、私とAIの役割表示、同じCodex作業の継続、実行前候補の共通境界までを扱う一時Agent。\n'
      : '自由発話をMac内で文字化し、私とAIの役割が分かる形で応答を表示する一時Agent。\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(join(work, 'package.json'), JSON.stringify({
    name: oneTurnMode ? 'rokid-personal-ai-one-turn-voice' : 'rokid-aiui-voice-knowledge-bridge',
    version: '0.1.0-test',
    private: true,
    description: oneTurnMode
      ? 'Persistent Codex voice conversation UI with a pending-effect boundary'
      : 'One-shot voice to read-only personal knowledge answer probe',
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'app.json'), JSON.stringify({
    pages: ['pages/index/index'],
    window: { navigationBarTitleText: '私のAI' },
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'VERSION'), `${randomUUID()}\n`, { encoding: 'utf8', mode: 0o600 });

  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: work });
  chmodSync(output, 0o600);
  console.log(`READY ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function replaceOnce(value, expected, replacement) {
  const first = value.indexOf(expected);
  if (first < 0 || value.indexOf(expected, first + expected.length) >= 0) {
    fail(`expected exactly one match: ${expected.slice(0, 80)}`);
  }
  return value.slice(0, first) + replacement + value.slice(first + expected.length);
}

function replaceOneTurnAudioLimits(value) {
  let updated = replaceOnce(value, 'maxDurationMs: 10000', 'maxDurationMs: 60000');
  updated = replaceOnce(updated, 'maxBytes: 320000', 'maxBytes: 1920000');
  return replaceOnce(updated, 'automaticStopOnSilence: true', 'automaticStopOnSilence: false');
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
