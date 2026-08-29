import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  candidateConfirmationBinding,
  ConfirmationTicketStore,
} from '../action-candidate/confirmation-ticket.mjs';
import { appendConversationActionRecord } from './conversation-log.mjs';
import {
  createGoogleDriveCandidate,
  GOOGLE_DRIVE_TARGET_HINT,
  googleDriveDocumentFromBoundCandidate,
  saveDocumentToGoogleDrive,
} from './google-drive-action.mjs';
import {
  createReplaceDocumentTextCandidate,
  editFromBoundCandidate,
  replaceExistingDocumentText,
} from './existing-document-edit.mjs';

export const DOCUMENT_TARGET_HINT = '私のAI 作成文書';
export const DEFAULT_DOCUMENT_ROOT =
  '/path/to/your/ObsidianVault/Rokidシステム化/作成文書/私のAI';
const DEFAULT_ALLOWED_PARENT = '/path/to/your/ObsidianVault/Rokidシステム化';

export function normalizeDocumentProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('document proposal must be an object');
  }
  const title = normalizeTitle(value.title);
  const body = normalizeBody(value.body);
  const targetHint = String(value.targetHint ?? '').normalize('NFKC').trim();
  if (targetHint !== DOCUMENT_TARGET_HINT) throw new Error('document target is not allowed');
  const markdown = `# ${title}\n\n${body}\n`;
  if (markdown.length > 500) throw new Error('document proposal is too long');
  return Object.freeze({ title, body, targetHint, markdown });
}

export function createDocumentCandidate({ request, proposal, candidateId = randomUUID() }) {
  const source = String(request ?? '').normalize('NFKC').trim();
  if (!source || source.length > 500 || /[\u0000-\u001f\u007f]/u.test(source)) {
    throw new Error('document source request is invalid');
  }
  const document = normalizeDocumentProposal(proposal);
  return Object.freeze({
    candidateId,
    sourceTextSha256: createHash('sha256').update(source).digest('hex'),
    disposition: 'propose_action',
    actionType: 'create_new_document',
    targetScope: 'obsidian',
    risk: 'low',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: `新規文書「${document.title}」を作成`,
    targetHint: document.targetHint,
    payloadPreview: document.markdown,
  });
}

export async function createAppendDocumentCandidate({
  request,
  proposal,
  candidateId = randomUUID(),
  ...options
}) {
  const source = normalizeSourceRequest(request);
  const document = normalizeAppendProposal(proposal);
  const snapshot = await readExistingDocumentSnapshot(document.title, options);
  return Object.freeze({
    candidateId,
    sourceTextSha256: createHash('sha256').update(source).digest('hex'),
    disposition: 'propose_action',
    actionType: 'append_document',
    targetScope: 'obsidian',
    risk: 'low',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: `既存文書「${document.title}」へ追記`,
    targetHint: document.targetHint,
    payloadPreview: `追記先: ${document.title}\n\n${document.body}`,
    resourceVersion: snapshot.sha256,
  });
}

export async function createNewDocument(candidate, authorization, options = {}) {
  const binding = candidateConfirmationBinding(candidate);
  if (authorization?.authorized !== true ||
      authorization.executionCapability !== 'create_new_document' ||
      authorization.candidateId !== binding.candidateId ||
      authorization.candidateDigest !== binding.digest) {
    throw new Error('confirmed document authorization is required');
  }
  if (binding.actionType !== 'create_new_document' ||
      binding.targetScope !== 'obsidian' ||
      binding.targetHint !== DOCUMENT_TARGET_HINT) {
    throw new Error('new document target is required');
  }
  const document = documentFromBoundCandidate(binding);
  const root = path.resolve(options.root ?? DEFAULT_DOCUMENT_ROOT);
  const allowedParent = path.resolve(options.allowedParent ?? DEFAULT_ALLOWED_PARENT);
  await ensureSafeDirectory({ root, allowedParent });
  const targetPath = path.join(root, `${document.title}.md`);
  const temporaryPath = path.join(root, `.new-document-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(document.markdown, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        return Object.freeze({
          applied: false,
          changed: false,
          state: 'already_exists',
          title: document.title,
        });
      }
      throw error;
    }
    return Object.freeze({
      applied: true,
      changed: true,
      state: 'saved',
      title: document.title,
      file: targetPath,
    });
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
  }
}

export async function appendExistingDocument(candidate, authorization, options = {}) {
  const binding = candidateConfirmationBinding(candidate);
  if (authorization?.authorized !== true ||
      authorization.executionCapability !== 'append_document' ||
      authorization.candidateId !== binding.candidateId ||
      authorization.candidateDigest !== binding.digest) {
    throw new Error('confirmed append authorization is required');
  }
  if (binding.actionType !== 'append_document' ||
      binding.targetScope !== 'obsidian' ||
      binding.targetHint !== DOCUMENT_TARGET_HINT ||
      !binding.resourceVersion) {
    throw new Error('existing document target is required');
  }
  const document = appendDocumentFromBoundCandidate(binding);
  const root = path.resolve(options.root ?? DEFAULT_DOCUMENT_ROOT);
  const allowedParent = path.resolve(options.allowedParent ?? DEFAULT_ALLOWED_PARENT);
  await ensureSafeDirectory({ root, allowedParent });
  const targetPath = path.join(root, `${document.title}.md`);
  let handle;
  try {
    handle = await open(targetPath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ applied: false, changed: false, state: 'not_found', title: document.title });
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256 * 1024) throw new Error('existing document is invalid');
    const current = await handle.readFile();
    const currentSha256 = createHash('sha256').update(current).digest('hex');
    if (currentSha256 !== binding.resourceVersion) {
      return Object.freeze({
        applied: false,
        changed: false,
        state: 'document_changed',
        title: document.title,
      });
    }
    const text = current.toString('utf8');
    const separator = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    await handle.writeFile(`${separator}${document.body}\n`, 'utf8');
    await handle.sync();
    return Object.freeze({
      applied: true,
      changed: true,
      state: 'appended',
      title: document.title,
      file: targetPath,
    });
  } finally {
    await handle.close();
  }
}

export function createNewDocumentCoordinator(options = {}) {
  const store = options.store ?? new ConfirmationTicketStore({
    ttlMs: 120_000,
    executionTtlMs: 15_000,
  });
  const applyDocument = options.applyDocument ?? ((candidate, authorization) =>
    createNewDocument(candidate, authorization, options));
  const applyAppend = options.applyAppend ?? ((candidate, authorization) =>
    appendExistingDocument(candidate, authorization, options));
  const applyEdit = options.applyEdit ?? ((candidate, authorization) =>
    replaceExistingDocumentText(candidate, authorization, options));
  const applyGoogleDrive = options.applyGoogleDrive ?? ((candidate, authorization) =>
    saveDocumentToGoogleDrive(candidate, authorization, options));
  const recordAction = options.recordAction ?? appendConversationActionRecord;
  const executionIdFactory = options.executionIdFactory ?? randomUUID;
  const pending = new Map();

  function propose({ request, proposal }) {
    const candidate = createDocumentCandidate({ request, proposal });
    const ticket = store.issue(candidate);
    pending.set(ticket.ticketId, candidate);
    const document = documentFromBoundCandidate(candidateConfirmationBinding(candidate));
    return Object.freeze({
      candidate,
      ticket,
      response: Object.freeze({
        documentProposal: Object.freeze({
          title: document.title,
          targetHint: DOCUMENT_TARGET_HINT,
          preview: document.body,
        }),
        ticketId: ticket.ticketId,
        candidateId: ticket.candidateId,
        confirmationToken: ticket.confirmationToken,
      }),
    });
  }

  async function proposeAppend({ request, proposal }) {
    const candidate = await createAppendDocumentCandidate({ request, proposal, ...options });
    const ticket = store.issue(candidate);
    pending.set(ticket.ticketId, candidate);
    const document = appendDocumentFromBoundCandidate(candidateConfirmationBinding(candidate));
    return Object.freeze({
      candidate,
      ticket,
      response: Object.freeze({
        documentProposal: Object.freeze({
          title: document.title,
          targetHint: DOCUMENT_TARGET_HINT,
          preview: document.body,
          action: 'append',
        }),
        ticketId: ticket.ticketId,
        candidateId: ticket.candidateId,
        confirmationToken: ticket.confirmationToken,
      }),
    });
  }

  async function proposeEdit({ request, proposal }) {
    const candidate = await createReplaceDocumentTextCandidate({ request, proposal, ...options });
    const ticket = store.issue(candidate);
    pending.set(ticket.ticketId, candidate);
    const edit = editFromBoundCandidate(candidateConfirmationBinding(candidate));
    return Object.freeze({
      candidate,
      ticket,
      response: Object.freeze({
        documentProposal: Object.freeze({
          title: edit.title,
          targetHint: candidate.targetHint,
          preview: `現在: ${edit.matchText}\n変更後: ${edit.replacementText}`,
          action: 'replace_text',
        }),
        ticketId: ticket.ticketId,
        candidateId: ticket.candidateId,
        confirmationToken: ticket.confirmationToken,
      }),
    });
  }

  function proposeGoogleDrive({ request, proposal }) {
    const candidate = createGoogleDriveCandidate({ request, proposal });
    const ticket = store.issue(candidate);
    pending.set(ticket.ticketId, candidate);
    const document = googleDriveDocumentFromBoundCandidate(candidateConfirmationBinding(candidate));
    return Object.freeze({
      candidate,
      ticket,
      response: Object.freeze({
        documentProposal: Object.freeze({
          title: document.title,
          targetHint: GOOGLE_DRIVE_TARGET_HINT,
          preview: document.body,
          action: 'save_to_google_docs',
        }),
        ticketId: ticket.ticketId,
        candidateId: ticket.candidateId,
        confirmationToken: ticket.confirmationToken,
      }),
    });
  }

  async function confirm(input) {
    const normalized = normalizeTicketInput(input);
    const candidate = pending.get(normalized.ticketId);
    if (!candidate) return routeResult(409, { ok: false, applied: false, changed: false, reason: 'invalid_ticket' });
    const decision = store.confirm(normalized);
    if (!decision.accepted) return routeResult(decision.reason === 'expired' ? 410 : 409, { ok: false, ...decision });
    const binding = candidateConfirmationBinding(candidate);
    const authorization = binding.actionType === 'append_document'
      ? store.claimAppendDocument({
        ticketId: normalized.ticketId,
        executionId: executionIdFactory(),
        candidate,
      })
      : binding.actionType === 'replace_document_text'
        ? store.claimReplaceDocumentText({
          ticketId: normalized.ticketId,
          executionId: executionIdFactory(),
          candidate,
        })
      : binding.actionType === 'save_document_to_google_drive'
        ? store.claimSaveGoogleDriveDocument({
          ticketId: normalized.ticketId,
          executionId: executionIdFactory(),
          candidate,
        })
        : store.claimCreateDocument({
        ticketId: normalized.ticketId,
        executionId: executionIdFactory(),
        candidate,
      });
    if (!authorization.authorized) {
      pending.delete(normalized.ticketId);
      return routeResult(409, { ok: false, applied: false, changed: false, reason: authorization.reason });
    }
    const document = binding.actionType === 'append_document'
      ? appendDocumentFromBoundCandidate(binding)
      : binding.actionType === 'replace_document_text'
        ? editFromBoundCandidate(binding)
      : binding.actionType === 'save_document_to_google_drive'
        ? googleDriveDocumentFromBoundCandidate(binding)
        : documentFromBoundCandidate(binding);
    const operation = binding.actionType;
    let applied;
    try {
      applied = operation === 'append_document'
        ? await applyAppend(candidate, authorization)
        : operation === 'replace_document_text'
          ? await applyEdit(candidate, authorization)
        : operation === 'save_document_to_google_drive'
          ? await applyGoogleDrive(candidate, authorization)
          : await applyDocument(candidate, authorization);
    } catch {
      pending.delete(normalized.ticketId);
      await recordAction({ operation, title: document.title, state: 'failed' }).catch(() => {});
      return routeResult(500, {
        ok: false,
        confirmationRecorded: true,
        applied: false,
        changed: false,
        reason: 'write_failed',
      });
    }
    pending.delete(normalized.ticketId);
    const actionRecorded = await recordAction({
      operation,
      title: document.title,
      state: applied.state,
    }).then(() => true, () => false);
    if (applied.applied !== true) {
      return routeResult(409, {
        ok: false,
        confirmationRecorded: true,
        applied: false,
        changed: false,
        actionRecorded,
        reason: applied.state,
        text: failureText(applied.state, operation),
      });
    }
    return routeResult(200, {
      ok: true,
      confirmationRecorded: true,
      applied: true,
      changed: true,
      actionRecorded,
      state: applied.state,
      text: actionRecorded
        ? operation === 'append_document'
          ? `「${document.title}」へ追記しました`
          : operation === 'replace_document_text'
            ? `「${document.title}」の一箇所を変更しました`
          : operation === 'save_document_to_google_drive'
            ? `「${document.title}」をGoogleドキュメントとして保存しました`
          : `「${document.title}」を保存しました`
        : operation === 'append_document'
          ? `「${document.title}」へ追記しましたが、実行結果の記録に失敗しました`
          : operation === 'replace_document_text'
            ? `「${document.title}」は変更しましたが、実行結果の記録に失敗しました`
          : operation === 'save_document_to_google_drive'
            ? `「${document.title}」はGoogleドキュメントとして保存しましたが、実行結果の記録に失敗しました`
          : `「${document.title}」は保存しましたが、実行結果の記録に失敗しました`,
    });
  }

  async function cancel(input) {
    const normalized = normalizeTicketInput(input);
    const candidate = pending.get(normalized.ticketId);
    const decision = store.cancel(normalized);
    if (!decision.accepted) return routeResult(decision.reason === 'expired' ? 410 : 409, { ok: false, ...decision });
    pending.delete(normalized.ticketId);
    let actionRecorded = true;
    if (candidate) {
      const binding = candidateConfirmationBinding(candidate);
      const document = binding.actionType === 'append_document'
        ? appendDocumentFromBoundCandidate(binding)
        : binding.actionType === 'replace_document_text'
          ? editFromBoundCandidate(binding)
        : binding.actionType === 'save_document_to_google_drive'
          ? googleDriveDocumentFromBoundCandidate(binding)
          : documentFromBoundCandidate(binding);
      actionRecorded = await recordAction({ operation: binding.actionType, title: document.title, state: 'cancelled' })
        .then(() => true, () => false);
    }
    return routeResult(200, { ok: true, ...decision, applied: false, changed: false, actionRecorded });
  }

  return Object.freeze({
    propose,
    proposeAppend,
    proposeEdit,
    proposeGoogleDrive,
    confirm,
    cancel,
    auditRecords: () => store.auditRecords(),
  });
}

function normalizeTitle(value) {
  const title = String(value ?? '').normalize('NFKC').trim();
  if (!title || title.length > 60 || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(title) ||
      title === '.' || title === '..' || title.startsWith('.') || /[. ]$/u.test(title)) {
    throw new Error('document title is invalid');
  }
  return title;
}

function normalizeBody(value) {
  const body = String(value ?? '').normalize('NFKC').replaceAll('\r\n', '\n').trim();
  if (!body || body.length > 400 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(body) || /<!--|-->/u.test(body)) {
    throw new Error('document body is invalid');
  }
  return body;
}

function normalizeSourceRequest(value) {
  const source = String(value ?? '').normalize('NFKC').trim();
  if (!source || source.length > 500 || /[\u0000-\u001f\u007f]/u.test(source)) {
    throw new Error('document source request is invalid');
  }
  return source;
}

function normalizeAppendProposal(value) {
  const document = normalizeDocumentProposal(value);
  return Object.freeze({ title: document.title, body: document.body, targetHint: document.targetHint });
}

function documentFromBoundCandidate(binding) {
  const match = binding.payloadPreview.match(/^# ([^\n]+)\n\n([\s\S]+)$/u);
  if (!match) throw new Error('bound document payload is invalid');
  return normalizeDocumentProposal({ title: match[1], body: match[2], targetHint: binding.targetHint });
}

function appendDocumentFromBoundCandidate(binding) {
  const match = binding.payloadPreview.match(/^追記先: ([^\n]+)\n\n([\s\S]+)$/u);
  if (!match) throw new Error('bound append payload is invalid');
  return normalizeAppendProposal({ title: match[1], body: match[2], targetHint: binding.targetHint });
}

async function readExistingDocumentSnapshot(title, options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_DOCUMENT_ROOT);
  const allowedParent = path.resolve(options.allowedParent ?? DEFAULT_ALLOWED_PARENT);
  await ensureSafeDirectory({ root, allowedParent });
  const targetPath = path.join(root, `${title}.md`);
  let handle;
  try {
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error('existing document was not found');
      notFound.code = 'DOCUMENT_NOT_FOUND';
      throw notFound;
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256 * 1024) throw new Error('existing document is invalid');
    const content = await handle.readFile();
    return Object.freeze({ sha256: createHash('sha256').update(content).digest('hex') });
  } finally {
    await handle.close();
  }
}

function failureText(state, operation) {
  if (state === 'already_exists') return '同名の文書があるため保存していません';
  if (state === 'not_found') return operation === 'replace_document_text'
    ? '指定した文書が見つからないため変更していません'
    : '指定した文書が見つからないため追記していません';
  if (state === 'document_changed') return operation === 'replace_document_text'
    ? '確認中に文書が変わったため変更していません'
    : '確認中に文書が変わったため追記していません';
  if (state === 'match_changed') return '確認中に対象の文が変わったため変更していません';
  return '文書を変更していません';
}

async function ensureSafeDirectory({ root, allowedParent }) {
  const parentReal = await realpath(allowedParent);
  const relative = path.relative(allowedParent, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('document root is outside the allowed Obsidian folder');
  }
  let current = parentReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('document root is unsafe');
    const currentReal = await realpath(current);
    if (currentReal !== current || !currentReal.startsWith(`${parentReal}${path.sep}`)) {
      throw new Error('document root escaped the allowed Obsidian folder');
    }
  }
}

function normalizeTicketInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ticket input is invalid');
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys.some((key) => !['ticketId', 'candidateId', 'confirmationToken'].includes(key))) {
    throw new Error('ticket input has unexpected fields');
  }
  return {
    ticketId: String(value.ticketId ?? ''),
    candidateId: String(value.candidateId ?? ''),
    confirmationToken: String(value.confirmationToken ?? ''),
  };
}

function routeResult(status, payload) {
  return Object.freeze({ status, payload: Object.freeze(payload) });
}
