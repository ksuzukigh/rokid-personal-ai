import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildActionCandidate } from './action-candidate.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_PATH);

function displayText(value, maximum, fallback) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) return fallback;
  if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('candidate preview text is invalid');
  }
  return text;
}

export function makeCandidatePreview(candidate) {
  if (!candidate || candidate.allowedNextStep !== 'preview_only' ||
      candidate.executionCapability !== 'none' || candidate.changed !== false) {
    throw new Error('candidate is not preview-only');
  }
  if (!['propose_action', 'clarify'].includes(candidate.disposition)) {
    throw new Error('candidate does not need a confirmation preview');
  }
  if (candidate.disposition === 'propose_action' && candidate.confirmationRequired !== true) {
    throw new Error('action candidate must require confirmation');
  }
  const unresolved = Array.isArray(candidate.unresolvedQuestions)
    ? candidate.unresolvedQuestions.map((item) => displayText(item, 80, '')).filter(Boolean)
    : [];
  const actionLabels = {
    create_or_append_note: 'メモの候補',
    update_record: '更新の候補',
    send_or_publish: '送信・公開の候補',
    delete: '削除の候補',
    purchase: '購入の候補',
    schedule: '予定の候補',
    other: '操作の候補',
  };
  return {
    disposition: candidate.disposition,
    kind: candidate.disposition === 'clarify'
      ? '確認が必要'
      : (actionLabels[candidate.actionType] ?? '操作の候補'),
    target: candidate.targetHint
      ? `対象: ${displayText(candidate.targetHint, 48, '未決定')}`
      : '対象: 未決定',
    payload: unresolved.length
      ? `要確認: ${unresolved.slice(0, 1).join('')}`
      : `内容: ${displayText(candidate.payloadPreview, 72, '詳細なし')}`,
  };
}

export function createCandidatePreviewAix(candidate, outputArgument) {
  const output = path.resolve(outputArgument);
  const preview = makeCandidatePreview(candidate);
  const source = path.join(MODULE_DIR, 'aiui-preview-source');
  const work = mkdtempSync(path.join(tmpdir(), 'rokid-action-candidate-preview-aix-'));
  try {
    mkdirSync(path.join(work, 'pages/index'), { recursive: true });
    cpSync(path.join(source, 'app.js'), path.join(work, 'app.js'));
    let page = readFileSync(path.join(source, 'pages/index/index.ink'), 'utf8');
    page = replaceOnce(page, '__CANDIDATE_PREVIEW__', JSON.stringify(preview));
    writeFileSync(path.join(work, 'pages/index/index.ink'), page, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(path.join(work, 'AGENTS.md'), [
      '# Agent: Rokid自由文候補確認テスト',
      '',
      '- Lunaが作った実行前候補を静的表示する。',
      '- テンプル操作は内容確認だけで、実行要求を送らない。',
      '- 通信、録音、保存、書き込み、外部操作を禁止する。',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    writeFileSync(
      path.join(work, 'README.md'),
      '自由文から作った候補を、変更なしでRV101へ表示・確認する一時Agent。\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({
      name: 'rokid-aiui-action-candidate-preview',
      version: '0.1.0-test',
      private: true,
      description: 'Static preview-only free-text action candidate for RV101',
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    writeFileSync(path.join(work, 'app.json'), JSON.stringify({
      pages: ['pages/index/index'],
      window: { navigationBarTitleText: '私のAI' },
    }, null, 2), { encoding: 'utf8', mode: 0o600 });

    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });
    execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: work });
    chmodSync(output, 0o600);
    return { output, preview };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function replaceOnce(value, expected, replacement) {
  const first = value.indexOf(expected);
  if (first < 0 || value.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`expected exactly one match: ${expected}`);
  }
  return value.slice(0, first) + replacement + value.slice(first + expected.length);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--utterance') result.utterance = argv[++index];
    else if (argv[index] === '--output') result.output = argv[++index];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.utterance || !args.output) {
    console.error('Usage: node prepare-candidate-preview-aix.mjs --utterance <text> --output <path>');
    process.exitCode = 2;
  } else {
    const candidate = await buildActionCandidate({ utterance: args.utterance });
    const result = createCandidatePreviewAix(candidate, args.output);
    process.stdout.write(`${JSON.stringify({
      output: result.output,
      candidateId: candidate.candidateId,
      sourceTextSha256: candidate.sourceTextSha256,
      disposition: candidate.disposition,
      actionType: candidate.actionType,
      risk: candidate.risk,
      confirmationRequired: candidate.confirmationRequired,
      executionCapability: candidate.executionCapability,
      changed: candidate.changed,
      audit: candidate.audit,
    }, null, 2)}\n`);
  }
}
