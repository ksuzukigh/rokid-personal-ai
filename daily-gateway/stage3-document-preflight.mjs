import { readdir, stat } from 'node:fs/promises';

import { createOneTurnAgent } from './one-turn-agent.mjs';
import {
  DEFAULT_DOCUMENT_ROOT,
  DOCUMENT_TARGET_HINT,
} from './new-document-action.mjs';

async function snapshotTarget() {
  try {
    const info = await stat(DEFAULT_DOCUMENT_ROOT);
    const names = info.isDirectory() ? await readdir(DEFAULT_DOCUMENT_ROOT) : [];
    return { exists: true, directory: info.isDirectory(), names: [...names].sort() };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, directory: false, names: [] };
    throw error;
  }
}

const before = await snapshotTarget();
const request = `「第3段階候補」という新しい文書を${DOCUMENT_TARGET_HINT}に作って。本文は「これは保存前候補の確認です。」にして。`;
const result = await createOneTurnAgent()({ request });
const after = await snapshotTarget();

if (result.operation !== 'create_new_document' || result.changed !== false ||
    result.documentProposal?.title !== '第3段階候補' ||
    result.documentProposal?.body !== 'これは保存前候補の確認です。' ||
    result.documentProposal?.targetHint !== DOCUMENT_TARGET_HINT) {
  throw new Error('real agent did not return the exact unexecuted new-document proposal');
}
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error('real document target changed during proposal-only preflight');
}

process.stdout.write(`${JSON.stringify({
  request,
  answer: result.answer,
  operation: result.operation,
  documentProposal: result.documentProposal,
  changed: result.changed,
  actualTargetUnchanged: true,
  targetSnapshot: after,
}, null, 2)}\n`);
