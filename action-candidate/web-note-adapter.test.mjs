import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfirmationTicketStore } from './confirmation-ticket.mjs';
import { applyConfirmedWebResearch, candidateFromWebResearch } from './web-note-adapter.mjs';

const request = 'Rokidの最新情報を調べて';
const research = { summary: '公式発表を確認した。', sources: [
  { title: 'Rokid公式', url: 'https://global.rokid.com/blogs/articles/example', keyPoint: '新しい発表があった。' },
] };

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rokid-web-note-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const targetPath = join(dir, 'web.md');
  await writeFile(targetPath, '# Web検索メモ\n');
  return { targetPath, store: new ConfirmationTicketStore({ ticketIdFactory: () => 'ticket-web-1', tokenFactory: () => 'secret-web-1' }) };
}

test('確認後だけ要約・ページ名・URL・要点を一件保存する', async (t) => {
  const f = await fixture(t);
  const candidate = candidateFromWebResearch(request, research, { candidateId: 'candidate-web-1' });
  const ticket = f.store.issue(candidate);
  assert.doesNotMatch(await readFile(f.targetPath, 'utf8'), /公式発表/);
  const confirmed = f.store.confirm(ticket);
  const result = await applyConfirmedWebResearch(candidate, request, research, confirmed, { targetPath: f.targetPath, now: new Date('2026-08-24T00:00:00Z') });
  assert.equal(result.changed, true);
  const note = await readFile(f.targetPath, 'utf8');
  assert.match(note, /2026-08-24 Web検索/);
  assert.match(note, /依頼: Rokidの最新情報/);
  assert.match(note, /\[Rokid公式\]\(https:\/\/global\.rokid\.com\/blogs\/articles\/example\)/);
  assert.equal((await applyConfirmedWebResearch(candidate, request, research, confirmed, { targetPath: f.targetPath })).changed, false);
});

test('未確認、別結果、別保存先を拒否して無変更にする', async (t) => {
  const f = await fixture(t);
  const candidate = candidateFromWebResearch(request, research, { candidateId: 'candidate-web-1' });
  const before = await readFile(f.targetPath, 'utf8');
  await assert.rejects(() => applyConfirmedWebResearch(candidate, request, research, { accepted: false }, { targetPath: f.targetPath }));
  const confirmed = f.store.confirm(f.store.issue(candidate));
  await assert.rejects(() => applyConfirmedWebResearch(candidate, request, { ...research, summary: '差し替えた結果' }, confirmed, { targetPath: f.targetPath }), /mismatch/);
  await assert.rejects(() => applyConfirmedWebResearch({ ...candidate, targetHint: '別ノート' }, request, research, confirmed, { targetPath: f.targetPath }));
  assert.equal(await readFile(f.targetPath, 'utf8'), before);
});
