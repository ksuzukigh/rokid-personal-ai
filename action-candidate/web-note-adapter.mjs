import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { candidateConfirmationBinding } from './confirmation-ticket.mjs';
import { validateWebRequest, validateWebResearch } from './web-research.mjs';

export const WEB_NOTE_PATH = '/path/to/your/ObsidianVault/Rokidシステム化/試用/Rokid Web検索メモ試用.md';
const MAX_BYTES = 128 * 1024;

export function canonicalWebResearch(requestValue, researchValue) {
  const request = validateWebRequest(requestValue);
  const research = validateWebResearch(researchValue);
  return { request, summary: research.summary, sources: research.sources };
}

function researchDigest(request, research) {
  return createHash('sha256').update(JSON.stringify(canonicalWebResearch(request, research))).digest('hex');
}

export function candidateFromWebResearch(request, research, { candidateId = randomUUID() } = {}) {
  const value = canonicalWebResearch(request, research);
  const preview = `検索${value.sources.length}件: ${clip(value.summary, 58)}`;
  return {
    candidateId,
    sourceTextSha256: researchDigest(request, research),
    disposition: 'propose_action',
    actionType: 'create_or_append_note',
    targetScope: 'obsidian',
    risk: 'low',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: `Web検索結果${value.sources.length}件を保存`,
    targetHint: 'Rokid Web検索メモ試用',
    payloadPreview: preview,
  };
}

export async function applyConfirmedWebResearch(candidate, request, research, confirmation, options = {}) {
  const binding = candidateConfirmationBinding(candidate);
  if (confirmation?.accepted !== true || confirmation.status !== 'confirmed' || confirmation.candidateId !== binding.candidateId || confirmation.candidateDigest !== binding.digest) throw new Error('confirmed_candidate_required');
  if (binding.actionType !== 'create_or_append_note' || binding.targetScope !== 'obsidian' || binding.targetHint !== 'Rokid Web検索メモ試用') throw new Error('web_note_target_required');
  if (binding.sourceTextSha256 !== researchDigest(request, research)) throw new Error('web_research_mismatch');
  const value = canonicalWebResearch(request, research);
  const targetPath = options.targetPath ?? WEB_NOTE_PATH;
  const current = await readSafe(targetPath);
  const marker = `<!-- rokid-web-candidate:${binding.candidateId} -->`;
  if (current.includes(marker)) return { applied: true, changed: false, state: 'already_saved', text: '保存済みでした' };
  const date = formatDate(options.now ?? new Date());
  const sources = value.sources.map((source, index) => `${index + 1}. [${markdownText(source.title)}](${source.url})\n   - ${markdownText(source.keyPoint)}`).join('\n');
  const block = `## ${date} Web検索\n\n依頼: ${markdownText(value.request)}\n\n要約: ${markdownText(value.summary)}\n\n### 出典\n\n${sources}\n\n${marker}`;
  const next = `${current.replace(/\s*$/, '')}\n\n${block}\n`;
  if (Buffer.byteLength(next) > MAX_BYTES) throw new Error('web_note_too_large');
  await replaceAtomically(targetPath, next);
  return { applied: true, changed: true, state: 'saved', text: 'Web検索メモへ保存しました' };
}

function clip(value, maximum) { return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`; }
function formatDate(value) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value); }
function markdownText(value) { return String(value).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&'); }

async function readSafe(targetPath) {
  const stat = await lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || await realpath(targetPath) !== targetPath) throw new Error('unsafe_web_note');
  const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

async function replaceAtomically(targetPath, content) {
  const parent = dirname(targetPath);
  if (await realpath(parent) !== parent) throw new Error('unsafe_web_note_parent');
  const temporaryPath = join(parent, `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  try {
    const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, targetPath); created = false;
  } finally { if (created) await rm(temporaryPath, { force: true }); }
}
