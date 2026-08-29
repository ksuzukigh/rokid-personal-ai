import { access, appendFile, chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONVERSATION_LOG_ROOT =
  '/path/to/your/ObsidianVault/Rokidシステム化/会話記録/私のAI';
const DEFAULT_ALLOWED_PARENT = '/path/to/your/ObsidianVault/Rokidシステム化';

export function normalizeConversationRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('conversation record must be an object');
  }
  const request = normalizeLine(value.request, 500, 'conversation request');
  const answer = normalizeLine(value.answer, 240, 'conversation answer');
  if (typeof value.usedPreviousTurn !== 'boolean') {
    throw new Error('conversation context usage must be boolean');
  }
  if (typeof value.completed !== 'boolean') {
    throw new Error('conversation completion must be boolean');
  }
  return Object.freeze({
    request,
    answer,
    usedPreviousTurn: value.usedPreviousTurn,
    completed: value.completed,
  });
}

export function createConversationRecorder(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_CONVERSATION_LOG_ROOT);
  const allowedParent = path.resolve(options.allowedParent ?? DEFAULT_ALLOWED_PARENT);
  const now = options.now ?? (() => new Date());

  return async function recordConversation(value) {
    const record = normalizeConversationRecord(value);
    const instant = now();
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
      throw new Error('conversation timestamp is invalid');
    }
    await ensureSafeRoot({ root, allowedParent });
    const { date, time } = jstParts(instant);
    const file = path.join(root, `${date}.md`);
    const exists = await access(file).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    const header = exists ? '' : `# 私のAI 会話記録 ${date}\n\n`;
    const body = [
      `## ${time}`,
      '',
      `- 私: ${escapeMarkdown(record.request)}`,
      `- AI: ${escapeMarkdown(record.answer)}`,
      `- 直前の会話: ${record.usedPreviousTurn ? '参照した' : '参照しなかった'}`,
      `- 状態: ${record.completed ? '完了' : '継続中'}`,
      '',
    ].join('\n');
    await appendFile(file, `${header}${body}`, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600);
    return Object.freeze({ recorded: true, file, date, time });
  };
}

export const appendConversationRecord = createConversationRecorder();

export function createConversationActionRecorder(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_CONVERSATION_LOG_ROOT);
  const allowedParent = path.resolve(options.allowedParent ?? DEFAULT_ALLOWED_PARENT);
  const now = options.now ?? (() => new Date());

  return async function recordConversationAction(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('conversation action record must be an object');
    }
    const operation = value.operation ?? 'create_new_document';
    if (!['create_new_document', 'append_document', 'replace_document_text',
      'save_document_to_google_drive'].includes(operation)) {
      throw new Error('conversation action operation is invalid');
    }
    const title = normalizeLine(value.title, 60, 'conversation action title');
    const states = new Map([
      ['saved', '保存しました'],
      ['saved_to_google_docs', 'Googleドキュメントとして保存しました'],
      ['appended', '追記しました'],
      ['text_replaced', '一箇所を変更しました'],
      ['already_exists', '同名文書があるため保存しませんでした'],
      ['not_found', '文書が見つからないため追記しませんでした'],
      ['document_changed', operation === 'replace_document_text'
        ? '確認中に文書が変わったため変更しませんでした'
        : '確認中に文書が変わったため追記しませんでした'],
      ['match_changed', '確認中に対象の文が変わったため変更しませんでした'],
      ['cancelled', '取り消しました'],
      ['failed', operation === 'append_document'
        ? '追記できませんでした'
        : operation === 'replace_document_text'
          ? '変更できませんでした'
        : operation === 'save_document_to_google_drive'
          ? 'Googleドキュメントとして保存できませんでした'
          : '保存できませんでした'],
    ]);
    const result = states.get(value.state);
    if (!result) throw new Error('conversation action state is invalid');
    const instant = now();
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
      throw new Error('conversation action timestamp is invalid');
    }
    await ensureSafeRoot({ root, allowedParent });
    const { date, time } = jstParts(instant);
    const file = path.join(root, `${date}.md`);
    const exists = await access(file).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    const header = exists ? '' : `# 私のAI 会話記録 ${date}\n\n`;
    const body = [
      `## ${time} 実行結果`,
      '',
      `- 操作: ${operation === 'append_document'
        ? '既存文書への追記'
        : operation === 'replace_document_text'
          ? '既存文書の一箇所変更'
        : operation === 'save_document_to_google_drive'
          ? 'Googleドキュメントの新規保存'
          : '新規文書'}「${escapeMarkdown(title)}」`,
      `- 結果: ${result}`,
      '',
    ].join('\n');
    await appendFile(file, `${header}${body}`, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600);
    return Object.freeze({ recorded: true, file, date, time });
  };
}

export const appendConversationActionRecord = createConversationActionRecorder();

async function ensureSafeRoot({ root, allowedParent }) {
  await mkdir(allowedParent, { recursive: true });
  const parentReal = await realpath(allowedParent);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error('conversation log root must not be a symbolic link');
  const rootReal = await realpath(root);
  if (rootReal !== parentReal && !rootReal.startsWith(`${parentReal}${path.sep}`)) {
    throw new Error('conversation log root is outside the allowed Obsidian folder');
  }
}

function normalizeLine(value, maximum, label) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text || text.length > maximum) throw new Error(`${label} is invalid`);
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${label} contains control characters`);
  return text;
}

function escapeMarkdown(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function jstParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
