import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDocumentEditPlanner } from './document-edit-planner.mjs';
import { createNewDocumentCoordinator } from './new-document-action.mjs';
import { createOneTurnAgent } from './one-turn-agent.mjs';

const request = 'Obsidianにある文書検索編集テストの、確認前になっているところを確認済みにして';
const temporaryParent = await mkdtemp(path.join(tmpdir(), 'rokid-document-edit-preflight-'));
const vaultRoot = path.join(temporaryParent, '保管庫');
const relativeTarget = 'Rokidシステム化/作成文書/私のAI/文書検索編集テスト.md';
const target = path.join(vaultRoot, relativeTarget);

try {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, '# 文書検索編集テスト\n\n編集状態は確認前\n', { mode: 0o600 });
  const before = await readFile(target);
  const result = await createOneTurnAgent()({ request });
  if (result.operation !== 'replace_document_text' || result.changed !== false) {
    throw new Error('real agent did not understand the natural document edit request');
  }
  const planned = await createDocumentEditPlanner()({
    request,
    initialProposal: result.documentProposal,
    previousTurn: {
      request: '文書検索編集テストを見つけて内容を要約して',
      answer: '対象文書には、編集状態は確認前と書かれています。',
      documentContext: {
        sources: [{
          path: relativeTarget,
          title: '文書検索編集テスト',
          section: '文書検索編集テスト',
          excerpt: '編集状態は確認前',
        }],
      },
    },
    usePreviousTurn: true,
  });
  const previewResult = before.toString('utf8').replace(
    planned.proposal.matchText,
    planned.proposal.replacementText,
  );
  if (planned.proposal.title !== '文書検索編集テスト' ||
      !before.toString('utf8').includes(planned.proposal.matchText) ||
      !previewResult.includes('編集状態は確認済み') ||
      previewResult.includes('編集状態は確認前')) {
    throw new Error(`grounded Luna planner did not resolve the exact document edit: ${JSON.stringify(planned.proposal)}`);
  }
  const pending = await createNewDocumentCoordinator({
    vaultRoot,
    allowedParent: temporaryParent,
  }).proposeEdit({ request, proposal: planned.proposal });
  if (pending.candidate.actionType !== 'replace_document_text' ||
      pending.candidate.targetHint !== planned.proposal.resolvedPath ||
      pending.candidate.changed !== false || !(await readFile(target)).equals(before)) {
    throw new Error('document changed before Rokid confirmation');
  }
  process.stdout.write(`${JSON.stringify({
    operation: result.operation,
    title: planned.proposal.title,
    currentText: planned.proposal.matchText,
    replacementText: planned.proposal.replacementText,
    resolvedTarget: pending.candidate.targetHint,
    targetResolution: planned.audit.source,
    candidatePrepared: true,
    isolatedFixture: true,
    actualTargetUnchanged: true,
  }, null, 2)}\n`);
} finally {
  await rm(temporaryParent, { recursive: true, force: true });
}
