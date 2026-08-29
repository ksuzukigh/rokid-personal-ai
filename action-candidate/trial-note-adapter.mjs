import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { candidateConfirmationBinding } from './confirmation-ticket.mjs';

export const TRIAL_NOTE_PATH = '/path/to/your/ObsidianVault/Rokidシステム化/試用/Rokid個人AIメモ試用.md';
const MAX_BYTES = 64 * 1024;

export async function applyConfirmedCandidate(candidate, confirmation, options = {}) {
  const binding = candidateConfirmationBinding(candidate);
  if (confirmation?.accepted !== true || confirmation.status !== 'confirmed' || confirmation.candidateId !== binding.candidateId || confirmation.candidateDigest !== binding.digest) throw new Error('confirmed_candidate_required');
  if (binding.actionType !== 'create_or_append_note' || binding.targetScope !== 'obsidian' || binding.targetHint !== 'Rokid個人AIの試用メモ') throw new Error('trial_note_target_required');
  const text = binding.payloadPreview.normalize('NFKC').trim();
  if (!text || text.length > 240 || /[\u0000-\u001f\u007f]/.test(text) || /<!--|-->/.test(text)) throw new Error('invalid_trial_note_text');
  const targetPath = options.targetPath ?? TRIAL_NOTE_PATH;
  const current = await readSafe(targetPath);
  const marker = `<!-- rokid-candidate:${binding.candidateId} -->`;
  if (current.includes(marker)) return { applied: true, changed: false, state: 'already_saved', text: 'すでに保存済みです' };
  const next = `${current.replace(/\s*$/, '')}\n- ${text} ${marker}\n`;
  if (Buffer.byteLength(next) > MAX_BYTES) throw new Error('trial_note_too_large');
  await replaceAtomically(targetPath, next);
  return { applied: true, changed: true, state: 'saved', text: '試用メモへ保存しました' };
}

async function readSafe(targetPath) {
  const stat = await lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || await realpath(targetPath) !== targetPath) throw new Error('unsafe_trial_note');
  const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

async function replaceAtomically(targetPath, content) {
  const parent = dirname(targetPath);
  if (await realpath(parent) !== parent) throw new Error('unsafe_trial_note_parent');
  const temporaryPath = join(parent, `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  try {
    const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, targetPath); created = false;
  } finally { if (created) await rm(temporaryPath, { force: true }); }
}
