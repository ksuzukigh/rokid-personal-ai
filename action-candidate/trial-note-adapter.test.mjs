import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfirmationTicketStore } from './confirmation-ticket.mjs';
import { applyConfirmedCandidate } from './trial-note-adapter.mjs';

const candidate = (overrides = {}) => ({ candidateId: 'candidate-test-001', sourceTextSha256: '1'.repeat(64), disposition: 'propose_action', actionType: 'create_or_append_note', targetScope: 'obsidian', risk: 'low', confirmationRequired: true, allowedNextStep: 'preview_only', executionCapability: 'none', changed: false, summary: '試用メモへ保存', targetHint: 'Rokid個人AIの試用メモ', payloadPreview: '今日の試験結果を記録する', ...overrides });
async function fixture(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'rokid-trial-note-'))); t.after(() => rm(dir, { recursive: true, force: true })); const targetPath = join(dir, 'trial.md'); await writeFile(targetPath, '# 試用\n'); return { targetPath, store: new ConfirmationTicketStore({ ticketIdFactory: () => 'ticket-1', tokenFactory: () => 'secret-token-1' }) }; }

test('確認済みの自由文候補を試用ノートへ一件だけ保存する', async (t) => { const f = await fixture(t); const value = candidate(); const confirmed = f.store.confirm(f.store.issue(value)); assert.equal((await applyConfirmedCandidate(value, confirmed, { targetPath: f.targetPath })).changed, true); assert.match(await readFile(f.targetPath, 'utf8'), /今日の試験結果/); assert.equal((await applyConfirmedCandidate(value, confirmed, { targetPath: f.targetPath })).changed, false); });
test('未確認または別の保存先は書き込まない', async (t) => { const f = await fixture(t); const value = candidate(); const before = await readFile(f.targetPath, 'utf8'); await assert.rejects(() => applyConfirmedCandidate(value, { accepted: false }, { targetPath: f.targetPath })); const confirmed = f.store.confirm(f.store.issue(value)); await assert.rejects(() => applyConfirmedCandidate(candidate({ targetHint: '別のノート' }), confirmed, { targetPath: f.targetPath })); assert.equal(await readFile(f.targetPath, 'utf8'), before); });
