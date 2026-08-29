import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { candidateConfirmationBinding } from '../action-candidate/confirmation-ticket.mjs';

export const OBSIDIAN_EDIT_TARGET_HINT = 'Obsidianの既存文書';
export const DEFAULT_OBSIDIAN_VAULT = '/path/to/your/ObsidianVault';
const DEFAULT_ALLOWED_PARENT = '/path/to/your/Obsidian';
const MAX_DOCUMENT_BYTES = 256 * 1024;

export function normalizeDocumentEditProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('document edit proposal must be an object');
  }
  const title = normalizeTitle(value.title);
  const matchText = normalizeText(value.matchText, 'document match text');
  const replacementText = normalizeText(value.replacementText, 'document replacement text');
  const targetHint = String(value.targetHint ?? '').normalize('NFKC').trim();
  if (targetHint !== OBSIDIAN_EDIT_TARGET_HINT) throw new Error('document edit target is not allowed');
  if (matchText === replacementText) throw new Error('document edit must change the text');
  return Object.freeze({ title, matchText, replacementText, targetHint });
}

export async function createReplaceDocumentTextCandidate({
  request,
  proposal,
  candidateId = randomUUID(),
  ...options
}) {
  const source = normalizeSourceRequest(request);
  const resolvedPath = normalizeOptionalResolvedPath(proposal?.resolvedPath);
  const edit = normalizeDocumentEditProposal(proposal);
  const snapshot = await findDocumentSnapshot(edit, options, resolvedPath);
  const resolvedEdit = Object.freeze({ ...edit, title: snapshot.title });
  return Object.freeze({
    candidateId,
    sourceTextSha256: sha256(source),
    disposition: 'propose_action',
    actionType: 'replace_document_text',
    targetScope: 'obsidian',
    risk: 'medium',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: `既存文書「${resolvedEdit.title}」の一箇所を変更`,
    targetHint: snapshot.relativePath,
    payloadPreview: editPayload(resolvedEdit),
    resourceVersion: snapshot.sha256,
  });
}

export async function replaceExistingDocumentText(candidate, authorization, options = {}) {
  const binding = candidateConfirmationBinding(candidate);
  if (authorization?.authorized !== true ||
      authorization.executionCapability !== 'replace_document_text' ||
      authorization.candidateId !== binding.candidateId ||
      authorization.candidateDigest !== binding.digest) {
    throw new Error('confirmed document edit authorization is required');
  }
  if (binding.actionType !== 'replace_document_text' || binding.targetScope !== 'obsidian' ||
      !binding.targetHint || !binding.resourceVersion) {
    throw new Error('existing document edit target is required');
  }
  const edit = editFromBoundCandidate(binding);
  const { rootReal, targetPath } = await resolveBoundTarget(binding.targetHint, options);
  let sourceHandle;
  try {
    sourceHandle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return unchanged('not_found', edit.title);
    throw error;
  }
  let current;
  let sourceInfo;
  try {
    sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile() || sourceInfo.size > MAX_DOCUMENT_BYTES) {
      throw new Error('existing document is invalid');
    }
    current = await sourceHandle.readFile();
  } finally {
    await sourceHandle.close();
  }
  if (sha256(current) !== binding.resourceVersion) return unchanged('document_changed', edit.title);
  const currentText = decodeUtf8(current);
  if (countOccurrences(currentText, edit.matchText) !== 1) {
    return unchanged('match_changed', edit.title);
  }
  const updatedText = currentText.replace(edit.matchText, edit.replacementText);
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.document-edit-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const temporary = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      sourceInfo.mode & 0o777,
    );
    temporaryCreated = true;
    try {
      await temporary.writeFile(updatedText, 'utf8');
      await temporary.sync();
      await temporary.chmod(sourceInfo.mode & 0o777);
    } finally {
      await temporary.close();
    }
    const latestInfo = await lstat(targetPath);
    const latestReal = await realpath(targetPath);
    if (latestInfo.isSymbolicLink() || !latestInfo.isFile() || latestReal !== targetPath ||
        latestInfo.dev !== sourceInfo.dev || latestInfo.ino !== sourceInfo.ino ||
        !latestReal.startsWith(`${rootReal}${path.sep}`)) {
      return unchanged('document_changed', edit.title);
    }
    const latest = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (sha256(await latest.readFile()) !== binding.resourceVersion) {
        return unchanged('document_changed', edit.title);
      }
    } finally {
      await latest.close();
    }
    await rename(temporaryPath, targetPath);
    temporaryCreated = false;
    return Object.freeze({
      applied: true,
      changed: true,
      state: 'text_replaced',
      title: edit.title,
      file: targetPath,
      sha256: sha256(Buffer.from(updatedText)),
    });
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
  }
}

export function editFromBoundCandidate(binding) {
  const match = binding.payloadPreview.match(
    /^文書: ([^\n]+)\n\n現在:\n([\s\S]+?)\n\n変更後:\n([\s\S]+)$/u,
  );
  if (!match) throw new Error('bound document edit payload is invalid');
  return normalizeDocumentEditProposal({
    title: match[1],
    matchText: match[2],
    replacementText: match[3],
    targetHint: OBSIDIAN_EDIT_TARGET_HINT,
  });
}

async function findDocumentSnapshot(edit, options, resolvedPath = null) {
  const { rootReal } = await resolveRoot(options);
  let resolvedTitle;
  let matches;
  if (resolvedPath) {
    const targetPath = path.resolve(rootReal, resolvedPath);
    const relative = path.relative(rootReal, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('resolved document target escaped the Obsidian vault');
    }
    const info = await lstat(targetPath).catch((error) => {
      if (error?.code === 'ENOENT') throw codedError('document was not found', 'DOCUMENT_NOT_FOUND');
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink() || path.extname(targetPath) !== '.md') {
      throw new Error('resolved document target is unsafe');
    }
    matches = [targetPath];
    resolvedTitle = path.basename(targetPath, '.md');
  } else {
    matches = [];
    const directories = [rootReal];
    while (directories.length) {
      const directory = directories.pop();
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile() && entry.name === `${edit.title}.md`) {
          matches.push(entryPath);
        }
      }
    }
    resolvedTitle = edit.title;
  }
  if (!matches.length) throw codedError('document was not found', 'DOCUMENT_NOT_FOUND');
  if (matches.length !== 1) throw codedError('document title is ambiguous', 'DOCUMENT_AMBIGUOUS');
  const targetPath = matches[0];
  const targetReal = await realpath(targetPath);
  if (targetReal !== targetPath || !targetReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error('document target is unsafe');
  }
  const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw new Error('existing document is invalid');
    const content = await handle.readFile();
    const text = decodeUtf8(content);
    const occurrences = countOccurrences(text, edit.matchText);
    if (occurrences === 0) throw codedError('document text was not found', 'DOCUMENT_TEXT_NOT_FOUND');
    if (occurrences !== 1) throw codedError('document text is ambiguous', 'DOCUMENT_TEXT_AMBIGUOUS');
    const relativePath = path.relative(rootReal, targetPath);
    if (!relativePath || relativePath.length > 160) throw new Error('document path is too long');
    return Object.freeze({ title: resolvedTitle, relativePath, sha256: sha256(content) });
  } finally {
    await handle.close();
  }
}

async function resolveBoundTarget(relativePath, options) {
  const { rootReal } = await resolveRoot(options);
  const targetPath = path.resolve(rootReal, relativePath);
  const relative = path.relative(rootReal, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('document target escaped the Obsidian vault');
  }
  return { rootReal, targetPath };
}

async function resolveRoot(options = {}) {
  const root = path.resolve(options.vaultRoot ?? DEFAULT_OBSIDIAN_VAULT);
  const allowedParent = path.resolve(options.allowedParent ?? DEFAULT_ALLOWED_PARENT);
  const parentReal = await realpath(allowedParent);
  const rootInfo = await lstat(root);
  const rootReal = await realpath(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      !rootReal.startsWith(`${parentReal}${path.sep}`)) {
    throw new Error('Obsidian vault is unsafe');
  }
  return { rootReal };
}

function editPayload(edit) {
  const payload = `文書: ${edit.title}\n\n現在:\n${edit.matchText}\n\n変更後:\n${edit.replacementText}`;
  if (payload.length > 500) throw new Error('document edit proposal is too long');
  return payload;
}

function normalizeTitle(value) {
  const title = String(value ?? '').normalize('NFKC').trim();
  if (!title || title.length > 60 || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(title) ||
      title === '.' || title === '..' || title.startsWith('.') || /[. ]$/u.test(title)) {
    throw new Error('document title is invalid');
  }
  return title;
}

function normalizeText(value, label) {
  const text = String(value ?? '').normalize('NFKC').replaceAll('\r\n', '\n').trim();
  if (!text || text.length > 400 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text) ||
      /<!--|-->/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function normalizeSourceRequest(value) {
  const source = String(value ?? '').normalize('NFKC').trim();
  if (!source || source.length > 500 || /[\u0000-\u001f\u007f]/u.test(source)) {
    throw new Error('document source request is invalid');
  }
  return source;
}

function normalizeOptionalResolvedPath(value) {
  if (value == null || value === '') return null;
  const resolvedPath = String(value).normalize('NFKC').trim().replaceAll('\\', '/');
  if (!resolvedPath || resolvedPath.length > 240 || path.posix.isAbsolute(resolvedPath) ||
      resolvedPath.split('/').some((part) => !part || part === '.' || part === '..') ||
      !resolvedPath.endsWith('.md') || /[\u0000-\u001f\u007f]/u.test(resolvedPath)) {
    throw new Error('resolved document path is invalid');
  }
  return resolvedPath;
}

function decodeUtf8(content) {
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) throw new Error('existing document is not valid UTF-8');
  return text;
}

function countOccurrences(text, matchText) {
  return text.split(matchText).length - 1;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function unchanged(state, title) {
  return Object.freeze({ applied: false, changed: false, state, title });
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
