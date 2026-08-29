import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createOneTurnAgent } from './one-turn-agent.mjs';
import {
  createAppendDocumentCandidate,
  DEFAULT_DOCUMENT_ROOT,
  DOCUMENT_TARGET_HINT,
} from './new-document-action.mjs';

const title = '第3段階テスト';
const body = '既存本文を残したまま、この一文を末尾へ追記します。';
const target = path.join(DEFAULT_DOCUMENT_ROOT, `${title}.md`);

async function snapshot() {
  const content = await readFile(target);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('append preflight target is not a regular file');
  return {
    size: info.size,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

const before = await snapshot();
const request = `${DOCUMENT_TARGET_HINT}にある「${title}」へ、「${body}」と追記して。`;
const result = await createOneTurnAgent()({ request });
if (result.operation !== 'append_document' || result.changed !== false ||
    result.documentProposal?.title !== title ||
    result.documentProposal?.body !== body ||
    result.documentProposal?.targetHint !== DOCUMENT_TARGET_HINT) {
  throw new Error('real agent did not return the exact unexecuted append proposal');
}
const candidate = await createAppendDocumentCandidate({ request, proposal: result.documentProposal });
const after = await snapshot();
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error('real document changed during append proposal-only preflight');
}
if (candidate.actionType !== 'append_document' || candidate.resourceVersion !== before.sha256) {
  throw new Error('append candidate did not bind the existing document version');
}

process.stdout.write(`${JSON.stringify({
  operation: result.operation,
  title,
  targetHint: result.documentProposal.targetHint,
  candidatePrepared: true,
  actualTargetUnchanged: true,
  before,
  after,
}, null, 2)}\n`);
