import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCandidatePreview } from './prepare-candidate-preview-aix.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXED_ORIGIN = 'https://personal-ai.example.com';

function text(value, maximum, field) {
  const result = String(value ?? '').trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

export function createConfirmationAix(candidate, ticket, session, outputArgument) {
  const origin = text(session?.origin, 128, 'origin');
  if (origin !== FIXED_ORIGIN) throw new Error('origin must be the fixed private-AI hostname');
  const payload = {
    preview: makeCandidatePreview(candidate), origin,
    bearer: text(session.bearer, 256, 'bearer'),
    ticketId: text(ticket?.ticketId, 128, 'ticket_id'),
    candidateId: text(ticket?.candidateId, 128, 'candidate_id'),
    confirmationToken: text(ticket?.confirmationToken, 256, 'confirmation_token'),
    applyOnConfirm: session.applyOnConfirm === true,
  };
  if (payload.bearer.length < 32) throw new Error('bearer is too short');
  const output = path.resolve(outputArgument);
  const source = path.join(MODULE_DIR, 'aiui-confirmation-source');
  const work = mkdtempSync(path.join(tmpdir(), 'rokid-action-confirmation-aix-'));
  try {
    mkdirSync(path.join(work, 'pages/index'), { recursive: true });
    cpSync(path.join(source, 'app.js'), path.join(work, 'app.js'));
    let page = readFileSync(path.join(source, 'pages/index/index.ink'), 'utf8');
    page = page.replace('__CONFIRMATION_SESSION__', JSON.stringify(payload));
    if (page.includes('__CONFIRMATION_SESSION__')) throw new Error('confirmation placeholder replacement failed');
    writeFileSync(path.join(work, 'pages/index/index.ink'), page, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(path.join(work, 'AGENTS.md'), '# Agent: Rokid一回確認\n\n- 候補確認または取消を一件だけMacへ送る。\n- 録音、保存、書き込み、外部操作を禁止する。\n', { mode: 0o600 });
    writeFileSync(path.join(work, 'app.json'), JSON.stringify({ pages: ['pages/index/index'], window: { navigationBarTitleText: '私のAI' } }, null, 2), { mode: 0o600 });
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'rokid-aiui-one-shot-confirmation', version: '0.1.0-test', private: true }, null, 2), { mode: 0o600 });
    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });
    execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: work });
    chmodSync(output, 0o600);
    return { output, preview: payload.preview };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
