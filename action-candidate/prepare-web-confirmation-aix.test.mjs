import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { candidateFromWebResearch } from './web-note-adapter.mjs';
import { createWebConfirmationAix } from './prepare-web-confirmation-aix.mjs';

const request = 'Rokidの最新情報を調べて';
const research = {
  summary: 'Rokid AI Glassesの公式情報を確認した。',
  sources: [
    { title: 'Rokid公式', url: 'https://www.rokid.com/en-US', keyPoint: '公式トップの情報。' },
    { title: 'Rokid Glasses製品ページ', url: 'https://global.rokid.com/products/rokid-glasses', keyPoint: '製品仕様の情報。' },
  ],
};
const ticket = { ticketId: 'ticket-web-001', candidateId: 'candidate-web-001', confirmationToken: 'ticket-secret-web-001' };
const session = { origin: 'https://personal-ai.example.com', bearer: 'b'.repeat(64) };

test('Web要約・出典名・URLをRV101用AIXへ入れる', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'web-confirmation-aix-test-'));
  try {
    const output = path.join(work, 'web-confirmation.aix');
    const unpacked = path.join(work, 'unpacked');
    const candidate = candidateFromWebResearch(request, research, { candidateId: ticket.candidateId });
    createWebConfirmationAix(candidate, ticket, request, research, session, output);
    execFileSync('/usr/bin/unzip', ['-qq', output, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    assert.match(page, /Rokid AI Glassesの公式情報/);
    assert.match(page, /Rokid Glasses製品ページ/);
    assert.match(page, /global\.rokid\.com\\?\/products\\?\/rokid-glasses/);
    assert.match(page, /まだObsidianへ保存していません/);
    assert.match(page, /body\.applied === true/);
    assert.doesNotMatch(page, /Recorder|Audio|camera|FileSystem|writeFile|storage|purchase|publish/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('検索結果と紐づかない候補を拒否する', () => {
  const candidate = candidateFromWebResearch(request, research, { candidateId: ticket.candidateId });
  assert.throws(() => createWebConfirmationAix({ ...candidate, payloadPreview: '差し替え' }, ticket, request, research, session, '/tmp/rejected-web.aix'), /bind/);
});
