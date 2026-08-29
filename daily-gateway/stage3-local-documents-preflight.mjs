import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createOneTurnAgent } from './one-turn-agent.mjs';

const SOURCE_PATH = '/path/to/your/ObsidianVault/Rokidシステム化/検証/検証台帳.md';
const request = 'Obsidianの検証台帳から、文書検索・要約・一箇所編集の最新の実機結果を100文字以内で要約して';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

const before = await readFile(SOURCE_PATH);
const result = await createOneTurnAgent()({ request });
const after = await readFile(SOURCE_PATH);

if (result.operation !== 'none' || result.completed !== true || result.changed !== false ||
    result.answer.length > 240 || result.tools.length !== 1 ||
    result.tools[0] !== 'local/obsidian-readonly') {
  throw new Error('real agent did not complete the local read-only document consultation');
}
if (!/0\.21\.0|文書/u.test(result.answer) || !/実機|合格/u.test(result.answer)) {
  throw new Error('real agent answer was not grounded in the requested document edit validation');
}
if (digest(before) !== digest(after)) {
  throw new Error('the requested source document changed during read-only consultation');
}

process.stdout.write(`${JSON.stringify({
  request,
  answer: result.answer,
  operation: result.operation,
  tools: result.tools,
  changed: result.changed,
  sourceUnchanged: true,
  sourceSha256: digest(after),
}, null, 2)}\n`);
