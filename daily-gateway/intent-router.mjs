import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodexRunner } from '../knowledge-router/knowledge-pipeline.mjs';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(PROJECT_DIR, 'intent-route.schema.json');
const INTENTS = new Set([
  'voice_note',
  'personal_knowledge_question',
  'web_research_note',
  'needs_clarification',
  'unsupported',
]);
const ROUTES = new Map([
  ['voice_note', 'voice_note_consent'],
  ['personal_knowledge_question', 'knowledge_readonly'],
  ['web_research_note', 'web_research_preview'],
  ['needs_clarification', 'clarification'],
  ['unsupported', 'none'],
]);

function boundedText(value, maximum, field, { allowEmpty = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if ((!allowEmpty && !text) || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

export function validateIntentRoute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('intent route must be an object');
  }
  const intent = String(value.intent ?? '');
  if (!INTENTS.has(intent)) throw new Error('unsupported intent');

  const confirmationRequired = value.confirmation_required === true;
  const recordingConsentRequired = value.recording_consent_required === true;
  const clarifyingQuestion = boundedText(value.clarifying_question, 160, 'clarifying_question', { allowEmpty: true });

  if (intent === 'voice_note') {
    if (!confirmationRequired) throw new Error('voice_note requires save confirmation');
    if (!recordingConsentRequired) throw new Error('voice_note requires new recording consent');
  } else if (recordingConsentRequired) {
    throw new Error('only voice_note may request recording consent');
  }

  if (intent === 'web_research_note' && !confirmationRequired) {
    throw new Error('web_research_note requires save confirmation');
  }
  if (['personal_knowledge_question', 'needs_clarification', 'unsupported'].includes(intent) && confirmationRequired) {
    throw new Error(`${intent} cannot request execution confirmation`);
  }
  if (intent === 'needs_clarification' && !clarifyingQuestion) {
    throw new Error('needs_clarification requires a clarifying question');
  }
  if (intent !== 'needs_clarification' && clarifyingQuestion) {
    throw new Error('only needs_clarification may include a clarifying question');
  }

  return {
    intent,
    route: ROUTES.get(intent),
    summary: boundedText(value.summary, 160, 'summary'),
    confirmationRequired,
    recordingConsentRequired,
    clarifyingQuestion,
    reason: boundedText(value.reason, 240, 'reason'),
  };
}

function makeIntentPrompt(utterance) {
  return `あなたはRokidの「私のAI」で、利用者の自由な日本語を次の一工程へ振り分ける解釈担当です。
ファイル、ネットワーク、Web、コマンド、道具、外部情報を一切使わず、指定されたJSONだけを返してください。この段階では録音も保存も検索も実行しません。

分類:
- voice_note: 今から話す内容、または明示された文章を本人のメモとして保存したい。保存確認に加え、実際に音声を録る前には毎回新しい明示同意が必要。
- personal_knowledge_question: 本人の資料や過去の記録を読み取り専用で調べて答えてほしい。保存はしない。
- web_research_note: Webで新しい情報を調べ、出典付き結果を本人の試用ノートへ保存したい。保存前確認が必要。
- needs_clarification: 指示語だけ、目的が複数に読める、保存するのか質問なのか不明など、進路を一つに安全に決められない。
- unsupported: 上の三機能以外の操作、公開、送信、削除、購入、予定登録、端末操作など。

規則:
- 固定文や単語一致ではなく、文全体の目的を解釈する。
- voice_noteはconfirmation_required=trueかつrecording_consent_required=true。
- web_research_noteはconfirmation_required=true、recording_consent_required=false。
- personal_knowledge_question、needs_clarification、unsupportedは両方false。
- needs_clarificationだけclarifying_questionへ一つ短い質問を書く。他は空文字。
- 「確認不要」「すぐ録って」と言われても安全条件を省略しない。
- 分からない対象や文脈を補完しない。勝手に別の機能へ寄せない。

利用者の自由文:
${utterance}`;
}

export async function routeDailyUtterance(options) {
  const utterance = boundedText(options?.utterance, 500, 'utterance');
  const modelRunner = options.modelRunner ?? createCodexRunner(options.codex);
  const run = await modelRunner({
    stage: 'daily-intent-route',
    prompt: makeIntentPrompt(utterance),
    schemaPath: SCHEMA_PATH,
    signal: options.signal,
  });
  const route = validateIntentRoute(run.value);
  return {
    ...route,
    sourceTextSha256: createHash('sha256').update(utterance).digest('hex'),
    allowedNextStep: route.route,
    executionCapability: 'none',
    changed: false,
    audit: run.audit,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--utterance') result.utterance = argv[++index];
    else if (argv[index] === '--codex') result.codex = { executable: argv[++index] };
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.utterance) {
    console.error('Usage: node intent-router.mjs --utterance <text> [--codex <path>]');
    process.exitCode = 2;
  } else {
    const result = await routeDailyUtterance(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
