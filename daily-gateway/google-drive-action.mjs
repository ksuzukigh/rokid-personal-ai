import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { candidateConfirmationBinding } from '../action-candidate/confirmation-ticket.mjs';
import { sanitizedEnvironment } from '../knowledge-router/knowledge-pipeline.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const EXPECTED_MCP_PACKAGE = '@piotr-agier/google-drive-mcp';
const DEFAULT_TIMEOUT_MS = 60_000;

export const GOOGLE_DRIVE_TARGET_HINT = 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)';
export const DEFAULT_GOOGLE_DRIVE_FOLDER_ID = '1dYPZgp-QeZdPFwpAP1S91Ti6oddaRMZ7';

export function normalizeGoogleDriveProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Google Drive proposal must be an object');
  }
  const title = normalizeTitle(value.title);
  const body = normalizeBody(value.body);
  const targetHint = String(value.targetHint ?? '').normalize('NFKC').trim();
  if (targetHint !== GOOGLE_DRIVE_TARGET_HINT) throw new Error('Google Drive target is not allowed');
  const documentText = `題名: ${title}\n\n本文:\n${body}\n`;
  if (documentText.length > 500) throw new Error('Google Drive proposal is too long');
  return Object.freeze({ title, body, targetHint, documentText });
}

export function createGoogleDriveCandidate({ request, proposal, candidateId = randomUUID() }) {
  const source = normalizeSourceRequest(request);
  const document = normalizeGoogleDriveProposal(proposal);
  return Object.freeze({
    candidateId,
    sourceTextSha256: createHash('sha256').update(source).digest('hex'),
    disposition: 'propose_action',
    actionType: 'save_document_to_google_drive',
    targetScope: 'google_drive',
    risk: 'low',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: `Google DriveへGoogleドキュメント「${document.title}」を保存`,
    targetHint: document.targetHint,
    payloadPreview: document.documentText,
  });
}

export function googleDriveDocumentFromBoundCandidate(binding) {
  const match = binding?.payloadPreview?.match(/^題名: ([^\n]+)\n\n本文:\n([\s\S]+)$/u);
  if (!match) throw new Error('bound Google Drive payload is invalid');
  return normalizeGoogleDriveProposal({
    title: match[1],
    body: match[2],
    targetHint: binding.targetHint,
  });
}

export async function saveDocumentToGoogleDrive(candidate, authorization, options = {}) {
  const binding = candidateConfirmationBinding(candidate);
  if (authorization?.authorized !== true ||
      authorization.executionCapability !== 'save_document_to_google_drive' ||
      authorization.candidateId !== binding.candidateId ||
      authorization.candidateDigest !== binding.digest) {
    throw new Error('confirmed Google Drive authorization is required');
  }
  if (binding.actionType !== 'save_document_to_google_drive' ||
      binding.targetScope !== 'google_drive' ||
      binding.targetHint !== GOOGLE_DRIVE_TARGET_HINT) {
    throw new Error('Google Drive document target is required');
  }
  const document = googleDriveDocumentFromBoundCandidate(binding);
  const folderId = String(options.googleDriveFolderId ?? DEFAULT_GOOGLE_DRIVE_FOLDER_ID);
  if (!/^[A-Za-z0-9_-]{10,200}$/u.test(folderId)) throw new Error('Google Drive folder ID is invalid');
  const drive = options.googleDriveClient ?? createGoogleDriveClient(options);
  const fileName = document.title;
  const before = await drive.listFolder(folderId);
  if (before.some((item) => item.name === fileName)) {
    return Object.freeze({ applied: false, changed: false, state: 'already_exists', title: document.title });
  }
  const created = await drive.createGoogleDoc({
    name: fileName,
    content: document.body,
    parentFolderId: folderId,
  });
  const after = await drive.listFolder(folderId);
  const verified = after.find((item) => item.name === fileName && item.id === created.id);
  if (!verified) throw new Error('Google Drive save verification failed');
  const readback = await drive.getGoogleDocContent(created.id);
  if (!readback.includes(document.body)) throw new Error('Google Docs content verification failed');
  return Object.freeze({
    applied: true,
    changed: true,
    state: 'saved_to_google_docs',
    title: document.title,
    fileId: created.id,
    contentSha256: createHash('sha256').update(document.body).digest('hex'),
  });
}

export function createGoogleDriveClient(options = {}) {
  const callTool = options.callGoogleDriveTool ?? ((name, args) => callGoogleDriveMcpTool(name, args, options));
  return Object.freeze({
    async listFolder(folderId) {
      const result = await callTool('listFolder', { folderId, pageSize: 100 });
      return parseFolderListing(toolText(result));
    },
    async createGoogleDoc(input) {
      const result = await callTool('createGoogleDoc', input);
      const text = toolText(result);
      const id = text.match(/(?:^|\n)ID:\s*([A-Za-z0-9_-]+)/u)?.[1];
      if (!id) throw new Error('Google Drive did not return a created Google Doc ID');
      return Object.freeze({ id });
    },
    async getGoogleDocContent(documentId) {
      const result = await callTool('getGoogleDocContent', { documentId });
      return toolText(result);
    },
  });
}

async function callGoogleDriveMcpTool(name, args, options = {}) {
  if (!['listFolder', 'createGoogleDoc', 'getGoogleDocContent'].includes(name)) {
    throw new Error('Google Drive tool is not allowed');
  }
  const transport = await loadGoogleDriveTransport(options);
  return new Promise((resolve, reject) => {
    const child = spawn(transport.command, transport.args, {
      cwd: transport.cwd || undefined,
      env: { ...sanitizedEnvironment(options.environment ?? process.env), ...transport.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error('Google Drive connection timed out')),
      options.googleDriveTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Google Drive connection closed with exit ${code}: ${stderr.slice(-200)}`));
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) return finish(new Error('Google Drive response is too large'));
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error('Google Drive initialization failed'));
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args },
          })}\n`);
        } else if (message.id === 2) {
          if (message.error) return finish(new Error('Google Drive operation failed'));
          finish(null, message.result);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'rokid-personal-ai', version: '0.22.2' },
      },
    })}\n`);
  });
}

async function loadGoogleDriveTransport(options) {
  const executable = options.codexExecutable ?? DEFAULT_CODEX;
  const { stdout } = await execFileAsync(executable, ['mcp', 'get', 'google-drive', '--json'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 2_000_000,
    env: sanitizedEnvironment(options.environment ?? process.env),
  });
  const value = JSON.parse(stdout);
  const transport = value?.transport;
  if (value?.enabled !== true || transport?.type !== 'stdio' ||
      !Array.isArray(transport.args) || !transport.args.includes(EXPECTED_MCP_PACKAGE) ||
      typeof transport.command !== 'string' || !transport.command.startsWith('/')) {
    throw new Error('approved Google Drive connection is unavailable');
  }
  const credential = transport.env?.GOOGLE_DRIVE_OAUTH_CREDENTIALS;
  if (typeof credential !== 'string' || !credential) throw new Error('Google Drive authentication is unavailable');
  return Object.freeze({
    command: transport.command,
    args: [...transport.args],
    cwd: transport.cwd ?? null,
    env: { GOOGLE_DRIVE_OAUTH_CREDENTIALS: credential },
  });
}

function toolText(result) {
  if (result?.isError === true) throw new Error('Google Drive operation was rejected');
  const text = (result?.content ?? [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Google Drive returned an empty response');
  return text;
}

function parseFolderListing(text) {
  const items = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^[📄📁]\s+(.+?)\s+\(ID:\s*([A-Za-z0-9_-]+)\)$/u);
    if (match) items.push(Object.freeze({ name: match[1], id: match[2] }));
  }
  return Object.freeze(items);
}

function normalizeTitle(value) {
  const title = String(value ?? '').normalize('NFKC').trim();
  if (!title || title.length > 60 || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(title) ||
      title === '.' || title === '..' || title.startsWith('.') || /[. ]$/u.test(title)) {
    throw new Error('Google Drive document title is invalid');
  }
  return title;
}

function normalizeBody(value) {
  const body = String(value ?? '').normalize('NFKC').replaceAll('\r\n', '\n').trim();
  if (!body || body.length > 400 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(body) || /<!--|-->/u.test(body)) {
    throw new Error('Google Drive document body is invalid');
  }
  return body;
}

function normalizeSourceRequest(value) {
  const source = String(value ?? '').normalize('NFKC').trim();
  if (!source || source.length > 500 || /[\u0000-\u001f\u007f]/u.test(source)) {
    throw new Error('Google Drive source request is invalid');
  }
  return source;
}
