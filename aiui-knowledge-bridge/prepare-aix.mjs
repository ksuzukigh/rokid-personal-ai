import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_QUESTION, normalizeSessionQuestion } from './relay.mjs';

const [baseAixArgument, outputAixArgument] = process.argv.slice(2);
const origin = process.env.ROKID_KNOWLEDGE_ORIGIN || '';
const token = process.env.ROKID_KNOWLEDGE_TOKEN || '';
const healthOnly = process.env.ROKID_KNOWLEDGE_HEALTH_ONLY === '1';
const question = healthOnly
  ? 'ROKID_FIXED_TRANSPORT_HEALTH_V1'
  : normalizeSessionQuestion(process.env.ROKID_KNOWLEDGE_QUESTION || DEFAULT_QUESTION);
const FIXED_ORIGIN = 'https://personal-ai.example.com';

if (!baseAixArgument || !outputAixArgument) fail('usage: node prepare-aix.mjs BASE_AIX OUTPUT_AIX');
if (!allowedOrigin(origin)) fail('origin must be the fixed Cloudflare hostname or an ephemeral Cloudflare tunnel');
if (Buffer.byteLength(token, 'utf8') < 32) fail('token must be at least 32 bytes');

const baseAix = resolve(baseAixArgument);
const outputAix = resolve(outputAixArgument);
const work = mkdtempSync(join(tmpdir(), 'rokid-aiui-knowledge-aix-'));

try {
  execFileSync('/usr/bin/unzip', ['-qq', baseAix, '-d', work]);
  const sourcePagePath = resolve(import.meta.dirname, 'templates/index-base.ink');
  let page = readFileSync(sourcePagePath, 'utf8');
  page = replaceOnce(page, "const PROBE_URL = 'https://js.rokid.com/api/v1/testing/http/echo';", `const PROBE_URL = '${origin}/v1/ask';`);
  page = replaceOnce(page, "const CANCEL_URL = '';", `const CANCEL_URL = '${origin}/v1/cancel';`);
  page = replaceOnce(page, "const PROBE_TOKEN = '';", `const PROBE_TOKEN = '${token}';`);
  page = replaceOnce(page, "const PROBE_TEXT = 'ROKID_AIUI_PROBE_V1';", `const PROBE_TEXT = ${JSON.stringify(question)};`);
  page = replaceOnce(page, "detail: '1回で送信・送信中にもう1回で取消',", "detail: '1回で始める・処理中にもう1回で取消',");
  page = replaceOnce(page, "state: '送信中',", "state: 'AIが確認中',");
  page = replaceOnce(page, "detail: '固定文字だけを送信',", "detail: 'Obsidianから必要箇所だけ検索',");
  page = replaceOnce(page, 'data: { requestId, text: PROBE_TEXT },', 'data: { requestId, question: PROBE_TEXT },');
  page = replaceOnce(
    page,
    "data: { requestId, question: PROBE_TEXT },\n      dataType: 'json',\n      success:",
    "data: { requestId, question: PROBE_TEXT },\n      dataType: 'json',\n      timeout: 70000,\n      success:",
  );
  page = replaceOnce(
    page,
    "const echoed = payload && payload.body ? payload.body : {};\n        const matched = echoed.requestId === requestId && echoed.text === PROBE_TEXT;",
    "const matched = payload && payload.ok === true &&\n        payload.requestId === requestId && typeof payload.answer === 'string' &&\n        payload.answer.length > 0 && payload.answer.length <= 160;",
  );
  page = replaceOnce(page, "state: matched ? '往復成功' : '応答不一致',", "state: matched ? 'AI' : '応答不一致',");
  page = replaceOnce(page, "detail: matched ? '受信しました' : '内容を採用しません',", "detail: matched ? payload.answer : '内容を採用しません',");
  page = replaceOnce(page, '<text class="title">文字往復テスト</text>', '<text class="title">私のAI</text>');
  page = replaceOnce(page, '<button class="action" bindtap="sendProbe">送信</button>', '<button class="action" bindtap="sendProbe">始める</button>');
  page = replaceOnce(page, 'font-size: 18px;\n  line-height: 22px;', 'font-size: 16px;\n  line-height: 21px;');

  if (healthOnly) {
    page = replaceOnce(page, `${origin}/v1/ask`, `${origin}/v1/health`);
    page = replaceOnce(
      page,
      "const matched = payload && payload.ok === true &&\n        payload.requestId === requestId && typeof payload.answer === 'string' &&\n        payload.answer.length > 0 && payload.answer.length <= 160;",
      "const matched = payload && payload.ok === true && payload.ready === true;",
    );
    page = replaceOnce(page, "state: matched ? 'AI' : '応答不一致',", "state: matched ? '接続成功' : '応答不一致',");
    page = replaceOnce(page, "detail: matched ? payload.answer : '内容を採用しません',", "detail: matched ? '録音していません' : '内容を採用しません',");
    page = replaceOnce(page, '<text class="title">私のAI</text>', '<text class="title">固定経路確認</text>');
    page = replaceOnce(page, '<button class="action" bindtap="sendProbe">始める</button>', '<button class="action" bindtap="sendProbe">接続を確認</button>');
    page = replaceOnce(page, "state: 'AIが確認中',", "state: '接続確認中',");
    page = replaceOnce(page, "detail: 'Obsidianから必要箇所だけ検索',", "detail: 'マイクとAIは使いません',");
  }

  writeFileSync(join(work, 'pages/index/index.ink'), page, { encoding: 'utf8', mode: 0o600 });
  const agentPurpose = healthOnly
    ? '固定名への認証付き接続を一回確認する。AIとObsidianは使わない。'
    : '指定した利用者の発言一件を認証済みMac中継へ送り、160文字以内のAI応答を表示する。';
  writeFileSync(join(work, 'AGENTS.md'), `# Agent: Rokid個人知識回答テスト\n\n- Version: 0.1.0-test\n- ${agentPurpose}\n- マイク、録音、音声認識、カメラ、保存、書き込み、実処理を禁止する。\n`, { encoding: 'utf8', mode: 0o600 });
  const readme = healthOnly
    ? '録音・AI・ObsidianなしでAIUIから固定名への認証付き接続を一回確認する一時Agent。\n'
    : '録音なしでAIUI固定質問→Mac→Luna→Obsidian→RV101表示を一回だけ検証する一時Agent。\n';
  writeFileSync(join(work, 'README.md'), readme, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'package.json'), JSON.stringify({
    name: 'rokid-aiui-knowledge-bridge',
    version: '0.1.0-test',
    private: true,
    description: 'One-shot fixed-text personal knowledge answer probe without recording',
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'app.json'), JSON.stringify({
    pages: ['pages/index/index'],
    window: { navigationBarTitleText: '私のAI' },
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'VERSION'), `${randomUUID()}\n`, { encoding: 'utf8', mode: 0o600 });

  rmSync(outputAix, { force: true });
  execFileSync('/usr/bin/zip', ['-q', '-r', outputAix, '.'], { cwd: work });
  chmodSync(outputAix, 0o600);
  console.log(`READY ${outputAix}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function replaceOnce(source, expected, replacement) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    fail(`expected exactly one match: ${expected.slice(0, 80)}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function allowedOrigin(value) {
  if (value === FIXED_ORIGIN) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      parsed.port === '' && parsed.pathname === '/' &&
      parsed.search === '' && parsed.hash === '' &&
      /^[a-z0-9-]+\.trycloudflare\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}
