import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodexRunner } from '../knowledge-router/knowledge-pipeline.mjs';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(PROJECT_DIR, 'action-candidate.schema.json');
const DISPOSITIONS = new Set(['propose_action', 'clarify', 'answer_only', 'refuse']);
const ACTION_TYPES = new Set([
  'none',
  'create_or_append_note',
  'update_record',
  'send_or_publish',
  'delete',
  'purchase',
  'schedule',
  'other',
]);
const TARGET_SCOPES = new Set([
  'obsidian',
  'calendar',
  'message',
  'external_service',
  'filesystem',
  'unknown',
]);
const RISKS = new Set(['none', 'low', 'medium', 'high']);
const RISK_ORDER = new Map([['none', 0], ['low', 1], ['medium', 2], ['high', 3]]);
const MINIMUM_RISK = new Map([
  ['create_or_append_note', 'low'],
  ['update_record', 'medium'],
  ['other', 'medium'],
  ['send_or_publish', 'high'],
  ['delete', 'high'],
  ['purchase', 'high'],
  ['schedule', 'high'],
]);

function boundedText(value, maximum, field, { allowEmpty = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if ((!allowEmpty && !text) || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function stringList(value, maximumItems, maximumCharacters, field) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${field} is invalid`);
  return value.map((item) => boundedText(item, maximumCharacters, field));
}

function safeTargetHint(value) {
  const target = boundedText(value, 160, 'target_hint', { allowEmpty: true });
  if (/^(?:[a-z]+:|\/|~)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(target)) {
    throw new Error('target_hint must be a human-readable hint, not a path or URI');
  }
  return target;
}

export function validateActionCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('action candidate must be an object');
  }
  const disposition = String(value.disposition ?? '');
  const actionType = String(value.action_type ?? '');
  const targetScope = String(value.target_scope ?? '');
  const risk = String(value.risk ?? '');
  if (!DISPOSITIONS.has(disposition)) throw new Error('unsupported disposition');
  if (!ACTION_TYPES.has(actionType)) throw new Error('unsupported action_type');
  if (!TARGET_SCOPES.has(targetScope)) throw new Error('unsupported target_scope');
  if (!RISKS.has(risk)) throw new Error('unsupported risk');

  const confirmationRequired = value.confirmation_required === true;
  if (disposition === 'propose_action') {
    if (actionType === 'none') throw new Error('proposed action needs an action_type');
    if (!confirmationRequired) throw new Error('every proposed action requires confirmation');
    const minimum = MINIMUM_RISK.get(actionType) ?? 'medium';
    if (RISK_ORDER.get(risk) < RISK_ORDER.get(minimum)) {
      throw new Error(`${actionType} risk must be at least ${minimum}`);
    }
  } else {
    if (actionType !== 'none') throw new Error('non-action disposition must use action_type none');
    if (confirmationRequired) throw new Error('non-action disposition cannot request execution confirmation');
  }

  return {
    disposition,
    actionType,
    summary: boundedText(value.summary, 160, 'summary'),
    targetScope,
    targetHint: safeTargetHint(value.target_hint),
    payloadPreview: boundedText(value.payload_preview, 500, 'payload_preview', { allowEmpty: true }),
    risk,
    confirmationRequired,
    unresolvedQuestions: stringList(value.unresolved_questions, 3, 160, 'unresolved_questions'),
    reason: boundedText(value.reason, 240, 'reason'),
  };
}

function makeCandidatePrompt(utterance) {
  return `あなたは利用者の自由な日本語を、実行前の候補へ整理するだけの解釈担当です。
ファイル、ネットワーク、コマンド、道具、外部情報を一切使わず、指定されたJSONだけを返してください。
この段階では、Obsidian、予定、メッセージ、Web、ファイルを絶対に変更しません。

規則:
- 単語一致や固定コマンドではなく、文全体の目的を解釈する。
- 実際の変更を望む依頼はdisposition=propose_actionにする。
- 提案する操作は必ずconfirmation_required=true。候補を作ることは実行許可ではない。
- 保存先や対象が曖昧なら、勝手に決めずtarget_scope=unknownまたはunresolved_questionsへ一つ短く書く。
- target_hintは「Rokid個人AIの検証記録」のような人向け説明だけにし、絶対パス、URL、コマンドを書かない。
- payload_previewは実行した場合に使う内容の短い見本であり、まだ保存しない。
- 公開・送信・削除・購入・予定登録はrisk=high。既存記録の更新はmedium以上。新規または追記メモはlow以上。
- 単なる質問、追加確認が必要、拒否すべき依頼はaction_type=none、confirmation_required=falseにする。
- 利用者が「すぐ」「確認不要」と言っても確認を省略しない。

利用者の自由文:
${utterance}`;
}

export async function buildActionCandidate(options) {
  const utterance = boundedText(options?.utterance, 500, 'utterance');
  const modelRunner = options.modelRunner ?? createCodexRunner(options.codex);
  const run = await modelRunner({
    stage: 'action-candidate',
    prompt: makeCandidatePrompt(utterance),
    schemaPath: SCHEMA_PATH,
    signal: options.signal,
  });
  const candidate = validateActionCandidate(run.value);
  return {
    candidateId: randomUUID(),
    sourceTextSha256: createHash('sha256').update(utterance).digest('hex'),
    ...candidate,
    allowedNextStep: 'preview_only',
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
    console.error('Usage: node action-candidate.mjs --utterance <text> [--codex <path>]');
    process.exitCode = 2;
  } else {
    const result = await buildActionCandidate(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
