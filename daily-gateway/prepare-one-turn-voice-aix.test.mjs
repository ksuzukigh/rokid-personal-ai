import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('../aiui-knowledge-bridge/prepare-voice-aix.mjs', import.meta.url));
const sessionSource = readFileSync(
  fileURLToPath(new URL('../aiui-knowledge-bridge/start-named-voice-session.mjs', import.meta.url)),
  'utf8',
);

test('Codex継続会話AIXはAIの聞き返しに同じ画面から答えられる', () => {
  const work = mkdtempSync(join(tmpdir(), 'one-turn-voice-aix-test-'));
  const aix = join(work, 'preview.aix');
  const unpacked = join(work, 'unpacked');
  try {
    execFileSync(process.execPath, [builder, aix], {
      env: {
        ...process.env,
        ROKID_ONE_TURN_VOICE: '1',
        ROKID_VOICE_KNOWLEDGE_PREVIEW_ONLY: '1',
      },
      stdio: 'ignore',
    });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = readFileSync(join(unpacked, 'pages/index/index.ink'), 'utf8');
    const audio = readFileSync(join(unpacked, 'lib/one-shot-audio.mjs'), 'utf8');
    const agents = readFileSync(join(unpacked, 'AGENTS.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'));

    assert.match(page, /wx\.media\.getRecorderManager\(\)/);
    assert.match(page, /maxDurationMs: 60000/);
    assert.match(page, /maxBytes: 1920000/);
    assert.match(page, /automaticStopOnSilence: false/);
    assert.match(page, /state: '聞いています'/);
    assert.match(page, /detail: '1回で終了'/);
    assert.match(page, /<text class="title">私のAI<\/text>/);
    assert.match(page, /finishRecording\('user_finished'\)/);
    assert.match(page, /wx:if="\{\{ actionLabel \}\}" class="action" bindtap="handlePrimaryAction"/);
    assert.match(page, /state: '考え中…'/);
    assert.match(page, /state: 'うまくいきませんでした'/);
    assert.match(page, /state: '接続できませんでした'/);
    assert.match(page, /event\.code === 'Backspace'/);
    assert.match(page, /const DOUBLE_TAP_EXIT_GRACE_MS = 650/);
    assert.match(page, /this\.clearPendingGlobalHookAction\(\);[\s\S]{0,240}this\.closeWaitingSession\(\)/);
    assert.match(page, /event\.code === 'GlobalHook'/);
    assert.match(page, /this\.pendingGlobalHookTimer = setTimeout/);
    assert.match(page, /}, DOUBLE_TAP_EXIT_GRACE_MS\)/);
    assert.match(page, /event\.code !== 'Enter'/);
    assert.match(page, /this\.clearPendingGlobalHookAction\(\);\s*this\.triggerPrimaryActionOnce\(\)/);
    assert.match(page, /closeWaitingSession\(\)/);
    assert.doesNotMatch(page, /wx\.exitMiniProgram\(\)/);
    assert.doesNotMatch(page, /wx\.navigateBack\(/);
    assert.match(page, /requestId: 'close-idle-session'/);
    assert.match(page, /const ALLOW_REPEAT = true/);
    assert.match(page, /const CODEX_CONVERSATION_MODE = true/);
    assert.match(page, /actionLabel: ALLOW_REPEAT \? '続けて話す' : '終了'/);
    assert.match(page, /showConversationTurn\(body\.text, body\.requestText\)/);
    assert.match(page, /showPendingEffect\(body\.text, body\.requestText, body\.effectProposal\)/);
    assert.match(page, /操作内容：\$\{effect\.summary\}/);
    assert.match(page, /対象：\$\{effect\.targetHint\}/);
    assert.match(page, /まだ実行していません/);
    assert.match(page, /phase: 'effect_confirmation'/);
    assert.match(page, /actionLabel: '実行する'/);
    assert.match(page, /confirmPendingEffect\(\)/);
    assert.match(page, /cancelPendingEffect\(\)/);
    assert.doesNotMatch(page, /body\.operation|documentProposal|confirm-document|cancel-document/);
    assert.match(page, /const ANSWER_REQUEST_TIMEOUT_MS = 630000/);
    assert.match(page, /timeout: ANSWER_REQUEST_TIMEOUT_MS/);
    assert.match(page, /const HEALTH_CHECK_ATTEMPTS = 2/);
    assert.match(page, /attempt <= HEALTH_CHECK_ATTEMPTS/);
    assert.match(page, /state: '準備中…', detail: ''/);
    assert.match(page, /prepareNextQuestion\(\{ startImmediately: true \}\)/);
    assert.match(page, /setTimeout\(\(\) => this\.startRecording\(\), 0\)/);
    assert.doesNotMatch(page, /phase === 'finished' && ALLOW_REPEAT\) \{\s*this\.prepareNextQuestion\(\);/);
    assert.match(page, /attemptUsed: false/);
    assert.match(audio, /maxDurationMs: 60000/);
    assert.match(audio, /maxBytes: 1920000/);
    assert.match(audio, /automaticStopOnSilence: false/);
    assert.match(page, /const TEST_LABEL = 'どうぞ'/);
    assert.doesNotMatch(page, /一回音声入力テスト|録音しますか|もう一度操作|RECORD_ARM|armRecording|armedAt|録音中 \$\{this\.session\.totalBytes\}|接続再確認中|録音はまだ始めません/);
    assert.doesNotMatch(page, /1回で録音確認/);
    assert.match(page, /body\.requestHandledAs === 'codex_conversation_turn'/);
    assert.match(page, /typeof body\.needsUserInput === 'boolean'/);
    assert.match(page, /typeof body\.usedPreviousTurn === 'boolean'/);
    assert.match(page, /body\.conversationRecorded === true/);
    assert.match(page, /body\.changed === false/);
    assert.match(page, /body\.sessionScoped === true/);
    assert.doesNotMatch(page, /free_conversation_turn|ephemeral/);
    assert.doesNotMatch(page, /intent|voice_note|web_research_note|personal_knowledge_question/);
    assert.match(page, /私：\$\{requestText/);
    assert.match(page, /AI：\$\{text\}/);
    assert.doesNotMatch(page, /質問：|回答：|質問できます|続けて質問/);
    assert.doesNotMatch(page, /setStorage|FileSystemManager|appendFile|writeFile/);
    assert.match(agents, /同じCodex作業の続き/);
    assert.match(agents, /共通実行境界へ渡す/);
    assert.match(agents, /このAIX自体はファイルを変更しない/);
    assert.doesNotMatch(agents, /直前1往復/);
    assert.doesNotMatch(agents, /二回目の録音を禁止/);
    assert.match(agents, /無音では終了せず、利用者の終了操作または最長60秒/);
    assert.equal(manifest.name, 'rokid-personal-ai-one-turn-voice');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('実行用AIXは機能別ではない共通確認受け口だけを持つ', () => {
  const work = mkdtempSync(join(tmpdir(), 'one-turn-document-aix-test-'));
  const aix = join(work, 'document.aix');
  const unpacked = join(work, 'unpacked');
  try {
    execFileSync(process.execPath, [builder, aix], {
      env: {
        ...process.env,
        ROKID_ONE_TURN_VOICE: '1',
        ROKID_VOICE_KNOWLEDGE_ORIGIN: 'https://personal-ai.example.com',
        ROKID_VOICE_KNOWLEDGE_TOKEN: '12345678901234567890123456789012',
      },
      stdio: 'ignore',
    });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = readFileSync(join(unpacked, 'pages/index/index.ink'), 'utf8');
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/transcribe/);
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/cancel/);
    assert.match(page, /操作内容：\$\{effect\.summary\}/);
    assert.match(page, /まだ実行していません/);
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/confirm-effect/);
    assert.match(page, /https:\/\/personal-ai\.example\.com\/v1\/cancel-effect/);
    assert.doesNotMatch(page, /confirm-document|cancel-document|NOTE_CANCEL_URL|body\.operation/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('一問一答音声セッションは専用受け口を使い公開確認後だけAIXを作る', () => {
  const health = sessionSource.indexOf('const publicHealth = await waitForPublicHealth(tunnel);');
  const build = sessionSource.indexOf("resolve(import.meta.dirname, 'prepare-voice-aix.mjs')");
  assert.ok(health >= 0 && build > health);
  assert.match(sessionSource, /one-turn-voice-relay\.mjs/);
  assert.match(sessionSource, /ROKID_ONE_TURN_VOICE/);
  assert.match(sessionSource, /rmSync\(outputAix, \{ force: true \}\)/);
});

test('処理中の簡潔な表示だけを録音なしで実機確認できる', () => {
  const work = mkdtempSync(join(tmpdir(), 'one-turn-processing-preview-test-'));
  const aix = join(work, 'processing-preview.aix');
  const unpacked = join(work, 'unpacked');
  try {
    execFileSync(process.execPath, [builder, aix], {
      env: {
        ...process.env,
        ROKID_ONE_TURN_VOICE: '1',
        ROKID_VOICE_KNOWLEDGE_PREVIEW_ONLY: '1',
        ROKID_ONE_TURN_PROCESSING_PREVIEW_ONLY: '1',
      },
      stdio: 'ignore',
    });
    execFileSync('/usr/bin/unzip', ['-qq', aix, '-d', unpacked]);
    const page = readFileSync(join(unpacked, 'pages/index/index.ink'), 'utf8');
    assert.match(page, /const PROCESSING_PREVIEW_ONLY = true/);
    assert.match(page, /state: '考え中…'/);
    assert.match(page, /detail: ''/);
    assert.match(page, /actionLabel: ''/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
