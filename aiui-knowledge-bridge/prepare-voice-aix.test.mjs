import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('./prepare-voice-aix.mjs', import.meta.url));
const sessionSource = readFileSync(
  fileURLToPath(new URL('./start-named-voice-session.mjs', import.meta.url)),
  'utf8',
);

test('自由発話AIXは一回録音と読み取り専用のAI応答だけを持つ', () => {
  const work = mkdtempSync(join(tmpdir(), 'voice-knowledge-aix-test-'));
  const aix = join(work, 'preview.aix');
  const unpacked = join(work, 'unpacked');
  try {
    execFileSync(process.execPath, [builder, aix], {
      env: { ...process.env, ROKID_VOICE_KNOWLEDGE_PREVIEW_ONLY: '1' },
      stdio: 'ignore',
    });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = readFileSync(join(unpacked, 'pages/index/index.ink'), 'utf8');
    const agents = readFileSync(join(unpacked, 'AGENTS.md'), 'utf8');

    assert.match(page, /const AUDIO_URL = '';/);
    assert.match(page, /const CANCEL_URL = '';/);
    assert.match(page, /const AUTH_TOKEN = '';/);
    assert.match(page, /wx\.media\.getRecorderManager\(\)/);
    assert.match(page, /maxDurationMs: 10000/);
    assert.match(page, /maxBytes: 320000/);
    assert.match(page, /minimumSpeechMs: 250/);
    assert.match(page, /minimumRecordingMs: 0/);
    assert.match(page, /automaticStopOnSilence: true/);
    assert.match(page, /trailingSilenceMs: 900/);
    assert.match(page, /attemptUsed: false/);
    assert.match(page, /const DOUBLE_TAP_EXIT_GRACE_MS = 650/);
    assert.match(page, /event\.code === 'GlobalHook'/);
    assert.match(page, /this\.pendingGlobalHookTimer = setTimeout/);
    assert.match(page, /this\.clearPendingGlobalHookAction\(\)/);
    assert.match(page, /state: '聞いています'/);
    assert.match(page, /detail: '1回で終了'/);
    assert.match(page, /state: '考え中…'/);
    assert.doesNotMatch(page, /録音中 \$\{this\.session\.totalBytes\}|録音しますか|もう一度操作|RECORD_ARM|armRecording|armedAt|接続再確認中|録音はまだ始めません/);
    assert.match(page, /const HEALTH_CHECK_ATTEMPTS = 2/);
    assert.match(page, /attempt <= HEALTH_CHECK_ATTEMPTS/);
    assert.match(page, /state: 'AI'/);
    assert.match(page, /detail: `私：\$\{requestText/);
    assert.match(page, /AI：\$\{text\}/);
    assert.doesNotMatch(page, /質問：|回答：|質問できます/);
    assert.doesNotMatch(page, /setStorage|FileSystemManager|appendFile|writeFile/);
    assert.match(agents, /保存、書き込み、外部操作、二回目の録音を禁止/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('本番AIXは固定Cloudflare名以外を拒否する', () => {
  const work = mkdtempSync(join(tmpdir(), 'voice-knowledge-origin-test-'));
  const aix = join(work, 'invalid.aix');
  try {
    assert.throws(() => execFileSync(
      process.execPath,
      [builder, aix],
      {
        env: {
          ...process.env,
          ROKID_VOICE_KNOWLEDGE_ORIGIN: 'https://example.com',
          ROKID_VOICE_KNOWLEDGE_TOKEN: 'x'.repeat(64),
        },
        stdio: 'ignore',
      },
    ));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('本番AIXは固定名と一回認証だけを持ち、AI応答後の確認操作を求めない', () => {
  const work = mkdtempSync(join(tmpdir(), 'voice-knowledge-live-aix-test-'));
  const aix = join(work, 'live.aix');
  const unpacked = join(work, 'unpacked');
  const token = 't'.repeat(64);
  try {
    execFileSync(process.execPath, [builder, aix], {
      env: {
        ...process.env,
        ROKID_VOICE_KNOWLEDGE_ORIGIN: 'https://personal-ai.example.com',
        ROKID_VOICE_KNOWLEDGE_TOKEN: token,
      },
      stdio: 'ignore',
    });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = readFileSync(join(unpacked, 'pages/index/index.ink'), 'utf8');
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/transcribe/);
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/cancel/);
    assert.equal(page.split(token).length - 1, 1);
    assert.match(page, /EVALUATION_ONLY && !CODEX_CONVERSATION_MODE/);
    assert.match(page, /this\.showConversationTurn\(body\.text, body\.requestText\)/);
    assert.match(page, /const EFFECT_CONFIRM_URL = '';/);
    assert.match(page, /const EFFECT_CANCEL_URL = '';/);
    assert.doesNotMatch(page, /\/v1\/confirm-effect|\/v1\/cancel-effect|NOTE_CANCEL_URL|confirm-document|cancel-document/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('固定名セッションは公開確認後だけAIXを作り、秘密環境を子処理へ残さない', () => {
  const health = sessionSource.indexOf('const publicHealth = await waitForPublicHealth(tunnel);');
  const build = sessionSource.indexOf("resolve(import.meta.dirname, 'prepare-voice-aix.mjs')");
  assert.ok(health >= 0 && build > health);
  assert.match(sessionSource, /'OPENAI_API_KEY'/);
  assert.match(sessionSource, /'CODEX_API_KEY'/);
  assert.match(sessionSource, /'OPENAI_BASE_URL'/);
  assert.match(sessionSource, /delete baseEnvironment\[name\]/);
  assert.match(sessionSource, /rmSync\(outputAix, \{ force: true \}\)/);
});
