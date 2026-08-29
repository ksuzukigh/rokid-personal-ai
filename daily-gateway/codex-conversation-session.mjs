import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizedEnvironment, spawnCapture } from '../knowledge-router/knowledge-pipeline.mjs';
import { normalizeOneTurnRequest } from './one-turn-agent.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT_DIR = path.dirname(MODULE_PATH);
const DEFAULT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_WORKSPACE = '/path/to/your/RokidWorkspace';
const SCHEMA_PATH = path.join(PROJECT_DIR, 'codex-conversation.schema.json');
export const DEFAULT_CONVERSATION_TIMEOUT_MS = 600_000;

function initialPrompt(userText) {
  return `あなたはRokidの「私のAI」として、利用者と一つの仕事を会話で進めます。

利用者は質問、依頼、説明を区別せず自然に話します。発言全体、これまでの同じ会話、実際に読める資料、現在使える道具と状態から目的を理解してください。操作名の一覧や決まった言い方へ当てはめないでください。

情報が足りない、候補が複数ある、対象を取り違えるおそれがある場合は、推測で進めず、利用者が答えやすい自然な聞き返しを一つ返し、needs_user_input=trueにしてください。次の利用者発言はこの同じCodex作業セッションへ届きます。

調査、読み取り、整理、計画は必要に応じて自分で進めてください。ただし、保存、編集、送信、公開、購入、予定登録など現実へ効果を及ぼす操作はこのセッション内で実行しません。

現在、共通境界へ提案できる現実操作は次の3種類だけです。これは会話の意味理解を分類する規則ではなく、現実へ効果を及ぼす最後の許可範囲です。
- create_obsidian_markdown: Obsidianの固定保存先へ新しいMarkdownを一件作る。titleとbodyを入れ、current_text、replacement_text、resolved_pathは空文字にする。
- replace_obsidian_text: Obsidian保管庫内の既存Markdownの一箇所だけを置換する。title、実文書に一度だけ現れるcurrent_text、replacement_textを入れ、bodyは空文字にする。正確な保管庫相対パスが分かる場合だけresolved_pathを入れ、分からなければ空文字にする。
- create_google_doc: Google Driveの固定フォルダへ新しいGoogleドキュメントを一件作る。titleとbodyを入れ、current_text、replacement_text、resolved_pathは空文字にする。

上のいずれかを実行する準備ができ、対象と内容を一つに特定できた場合だけeffect_proposalへaction、summary、detailsと必要な正確な値を入れてください。共通境界は固定保存先、実在する対象、現在の内容、利用者の別の確認を再検証します。送信、公開、共有、削除、移動、任意フォルダへの保存、Drive既存文書の編集など許可外の操作は提案せず、未対応であることを自然に説明してeffect_proposal=nullにしてください。現実への効果が不要な場合もeffect_proposal=nullです。

messageはRokidに表示する自然な日本語240文字以内です。message、summary、detailsの文字列内に改行を入れず、一行の値として返してください。内部の分類名、道具名、JSONの説明を利用者へ見せないでください。

私：${userText}`;
}

function continuationPrompt(userText) {
  return `利用者の続きの発言です。これまでの同じ仕事の文脈を保って考え、必要ならさらに自然に聞き返してください。\n\n私：${userText}`;
}

export function extractCodexSessionId(output) {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'thread.started' && event?.type !== 'session.started') continue;
    const candidate = event.thread_id ?? event.session_id ?? event.id ?? event.thread?.id;
    if (typeof candidate === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(candidate)) return candidate;
  }
  throw new Error('Codex conversation session id was not returned');
}

export function normalizeConversationResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('conversation response must be an object');
  }
  const message = String(value.message ?? '').normalize('NFKC').trim();
  if (!message || message.length > 240 || /[\u0000-\u001f\u007f]/u.test(message)) {
    throw new Error('conversation message is invalid');
  }
  if (typeof value.needs_user_input !== 'boolean') {
    throw new Error('conversation response requires needs_user_input');
  }
  let effectProposal = null;
  if (value.effect_proposal != null) {
    if (typeof value.effect_proposal !== 'object' || Array.isArray(value.effect_proposal)) {
      throw new Error('effect proposal must be an object or null');
    }
    const summary = normalizeLine(value.effect_proposal.summary, 240, 'effect summary');
    const details = normalizeLine(value.effect_proposal.details, 2000, 'effect details');
    if (!summary || summary.length > 240 || !details || details.length > 2000 ||
        /[\u0000-\u001f\u007f]/u.test(summary) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(details)) {
      throw new Error('effect proposal is invalid');
    }
    const action = String(value.effect_proposal.action ?? '');
    const title = normalizeLine(value.effect_proposal.title, 60, 'effect title');
    if (action === 'create_obsidian_markdown' || action === 'create_google_doc') {
      if (String(value.effect_proposal.current_text ?? '') ||
          String(value.effect_proposal.replacement_text ?? '') ||
          String(value.effect_proposal.resolved_path ?? '')) {
        throw new Error('new document effect contains edit fields');
      }
      const body = normalizeEffectText(value.effect_proposal.body, 400, 'effect body');
      effectProposal = Object.freeze({ action, summary, details, title, body });
    } else if (action === 'replace_obsidian_text') {
      if (String(value.effect_proposal.body ?? '')) throw new Error('document edit effect contains a body');
      const currentText = normalizeEffectText(value.effect_proposal.current_text, 400, 'current effect text');
      const replacementText = normalizeEffectText(value.effect_proposal.replacement_text, 400, 'replacement effect text');
      if (currentText === replacementText) throw new Error('effect edit must change the text');
      const resolvedPath = value.effect_proposal.resolved_path == null
        ? null
        : normalizeRelativeMarkdownPath(value.effect_proposal.resolved_path);
      effectProposal = Object.freeze({
        action, summary, details, title, currentText, replacementText,
        ...(resolvedPath ? { resolvedPath } : {}),
      });
    } else {
      throw new Error('effect action is not allowed');
    }
  }
  if (value.needs_user_input && effectProposal) {
    throw new Error('clarification cannot also be an executable effect proposal');
  }
  return Object.freeze({ message, needsUserInput: value.needs_user_input, effectProposal });
}

function normalizeLine(value, maximum, label) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function normalizeEffectText(value, maximum, label) {
  const text = String(value ?? '').normalize('NFKC').replaceAll('\r\n', '\n').trim();
  if (!text || text.length > maximum || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text) || /<!--|-->/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function normalizeRelativeMarkdownPath(value) {
  const relativePath = String(value ?? '').normalize('NFKC').trim().replaceAll('\\', '/');
  if (!relativePath || relativePath.length > 240 || path.posix.isAbsolute(relativePath) ||
      relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
      !relativePath.endsWith('.md') || /[\u0000-\u001f\u007f]/u.test(relativePath)) {
    throw new Error('effect document path is invalid');
  }
  return relativePath;
}

export function createCodexConversationSession(options = {}) {
  const executable = options.executable ?? DEFAULT_CODEX;
  const model = options.model ?? DEFAULT_MODEL;
  const workspace = options.workspace ?? DEFAULT_WORKSPACE;
  const runProcess = options.runProcess ?? spawnCapture;
  const environment = sanitizedEnvironment(options.environment ?? process.env);
  let effectBoundaryPolicyPromise = null;
  let sessionId = null;
  let closed = false;

  return Object.freeze({
    get sessionId() { return sessionId; },
    get closed() { return closed; },

    async send(text, { signal } = {}) {
      if (closed) throw new Error('Codex conversation session is closed');
      const userText = normalizeOneTurnRequest(text);
      const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rokid-codex-conversation-'));
      const outputPath = path.join(temporaryDirectory, 'response.json');
      try {
        if (!effectBoundaryPolicyPromise) {
          effectBoundaryPolicyPromise = options.effectBoundaryArgs
            ? Promise.resolve(Object.freeze({ args: [...options.effectBoundaryArgs], environment }))
            : buildEffectBoundaryPolicy({
              executable,
              workspace,
              environment,
              runProcess: options.runPolicyProcess ?? spawnCapture,
            });
        }
        const effectBoundaryPolicy = await effectBoundaryPolicyPromise;
        const effectBoundaryArgs = effectBoundaryPolicy.args;
        const firstTurn = sessionId === null;
        const args = firstTurn
          ? ['exec', '--model', model, '--sandbox', 'read-only', '--skip-git-repo-check',
            ...effectBoundaryArgs, '--json', '--output-schema', SCHEMA_PATH,
            '--output-last-message', outputPath, '-']
          : ['exec', 'resume', '--model', model, '-c', 'sandbox_mode="read-only"',
            ...effectBoundaryArgs, '--skip-git-repo-check', '--json',
            '--output-schema', SCHEMA_PATH, '--output-last-message', outputPath, sessionId, '-'];
        const result = await runProcess(executable, args, {
          cwd: workspace,
          env: effectBoundaryPolicy.environment,
          input: firstTurn ? initialPrompt(userText) : continuationPrompt(userText),
          timeoutMs: options.timeoutMs ?? DEFAULT_CONVERSATION_TIMEOUT_MS,
          maximumBytes: options.maximumBytes ?? 20_000_000,
          signal,
        });
        if (result.code !== 0) throw new Error(`Codex conversation failed with exit ${result.code}`);
        if (firstTurn) sessionId = extractCodexSessionId(result.stdout);
        const response = normalizeConversationResponse(JSON.parse(await fs.readFile(outputPath, 'utf8')));
        return Object.freeze({ ...response, sessionId });
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (!sessionId) return;
      const id = sessionId;
      sessionId = null;
      const result = await runProcess(executable, ['delete', '--force', id], {
        cwd: workspace,
        env: environment,
        timeoutMs: options.deleteTimeoutMs ?? 30_000,
        maximumBytes: 1_000_000,
      });
      if (result.code !== 0) throw new Error(`Codex conversation cleanup failed with exit ${result.code}`);
    },
  });
}

export async function buildEffectBoundaryPolicy(options = {}) {
  const executable = options.executable ?? DEFAULT_CODEX;
  const workspace = options.workspace ?? DEFAULT_WORKSPACE;
  const environment = sanitizedEnvironment(options.environment ?? process.env);
  const runProcess = options.runProcess ?? spawnCapture;
  const getMcp = async (name) => {
    const result = await runProcess(executable, ['mcp', 'get', name, '--json'], {
      cwd: workspace,
      env: environment,
      timeoutMs: 15_000,
      maximumBytes: 2_000_000,
    });
    if (result.code !== 0) return null;
    return JSON.parse(result.stdout);
  };
  const configArgs = ['--ignore-user-config'];
  const safeEnvironment = isolatedConversationEnvironment(environment);

  const history = await getMcp('computer-history');
  if (history) {
    const transport = history.transport;
    if (history.enabled !== true || transport?.type !== 'stdio' ||
        transport.command !== './bin/computer-use-client-launcher' ||
        JSON.stringify(transport.args) !== JSON.stringify(['computer-history', 'mcp']) ||
        !Array.isArray(transport.env_vars) || !transport.env_vars.includes('CODEX_HOME') ||
        typeof transport.cwd !== 'string' ||
        !transport.cwd.includes('/computer-history/')) {
      throw new Error('Computer History safety transport is invalid');
    }
    configArgs.push('-c', `mcp_servers.computer-history=${tomlInlineTransport({
      command: transport.command,
      args: transport.args,
      cwd: transport.cwd,
      envVars: ['CODEX_HOME'],
    })}`);
  }

  const search = await getMcp('bright-data');
  if (search) {
    const transport = search.transport;
    const apiToken = transport?.env?.API_TOKEN;
    if (search.enabled !== true || transport?.type !== 'stdio' ||
        typeof transport.command !== 'string' || !path.isAbsolute(transport.command) ||
        !transport.command.endsWith('/npx') ||
        JSON.stringify(transport.args) !== JSON.stringify(['-y', '@brightdata/mcp']) ||
        typeof apiToken !== 'string' || apiToken.length < 16) {
      throw new Error('read-only Web search transport is invalid');
    }
    safeEnvironment.API_TOKEN = apiToken;
    configArgs.push('-c', `mcp_servers.bright-data=${tomlInlineTransport({
      command: transport.command,
      args: transport.args,
      envVars: ['API_TOKEN'],
    })}`);
  }
  return Object.freeze({
    args: Object.freeze(configArgs),
    environment: Object.freeze(safeEnvironment),
  });
}

function isolatedConversationEnvironment(source) {
  const environment = {};
  for (const name of [
    'HOME', 'CODEX_HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SHELL', 'USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ]) {
    if (typeof source[name] === 'string' && source[name]) environment[name] = source[name];
  }
  return environment;
}

function tomlInlineTransport({ command, args, cwd = null, envVars = [] }) {
  const fields = [
    `command=${JSON.stringify(command)}`,
    `args=[${args.map((value) => JSON.stringify(value)).join(',')}]`,
    `env_vars=[${envVars.map((value) => JSON.stringify(value)).join(',')}]`,
    'enabled=true',
  ];
  if (cwd) fields.push(`cwd=${JSON.stringify(cwd)}`);
  return `{${fields.join(',')}}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  console.error('This module is used by the private Mac companion and is not a standalone command.');
  process.exitCode = 2;
}
