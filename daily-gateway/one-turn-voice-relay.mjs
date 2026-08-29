import { pathToFileURL } from 'node:url';

import { createAudioRelay, transcribePcm } from '../aiui-knowledge-bridge/audio-relay.mjs';
import { appendConversationRecord } from './conversation-log.mjs';
import { createCodexConversationSession } from './codex-conversation-session.mjs';
import { OBSIDIAN_EDIT_TARGET_HINT } from './existing-document-edit.mjs';
import { GOOGLE_DRIVE_TARGET_HINT } from './google-drive-action.mjs';
import { planDocumentEdit } from './document-edit-planner.mjs';
import {
  createNewDocumentCoordinator,
  DOCUMENT_TARGET_HINT,
} from './new-document-action.mjs';
import { answerOneTurn, normalizeOneTurnRequest } from './one-turn-agent.mjs';

function createLegacyOneTurnVoiceProcessor({
  transcribe = transcribePcm,
  agent = answerOneTurn,
  recordConversation = appendConversationRecord,
  documentCoordinator = createNewDocumentCoordinator(),
  editPlanner = planDocumentEdit,
} = {}) {
  if (typeof recordConversation !== 'function') throw new Error('conversation recorder is required');
  let previousTurn = null;
  const processVoice = async (pcm, { signal } = {}) => {
    const startedAt = Date.now();
    const transcript = await transcribe(pcm, { signal });
    throwIfAborted(signal);
    const request = normalizeOneTurnRequest(transcript?.text);
    const result = await agent({ request, previousTurn, signal });
    throwIfAborted(signal);
    if (result?.requestHandledAs !== 'free_conversation_turn' || result?.changed !== false || result?.ephemeral !== true) {
      throw new Error('one-turn voice agent returned an unsafe result');
    }
    let text = String(result.answer ?? '').normalize('NFKC').trim();
    if (!text || text.length > 240) throw new Error('one-turn voice answer must be 1 to 240 characters');
    let operation = result.operation ?? 'none';
    let completed = result.completed === true;
    let confirmation = null;
    let nextDocumentContext = result.documentContext ?? null;
    if (operation === 'create_new_document') {
      if (!result.documentProposal) throw new Error('new document proposal is required');
      confirmation = documentCoordinator.propose({ request, proposal: result.documentProposal });
    } else if (operation === 'append_document') {
      if (!result.documentProposal) throw new Error('append document proposal is required');
      try {
        confirmation = await documentCoordinator.proposeAppend({ request, proposal: result.documentProposal });
      } catch (error) {
        if (error?.code !== 'DOCUMENT_NOT_FOUND') throw error;
        text = `「${result.documentProposal.title}」が専用フォルダに見つからないため、追記候補を用意できませんでした。`;
        operation = 'none';
        completed = false;
      }
    } else if (operation === 'replace_document_text') {
      if (!result.documentProposal) throw new Error('document edit proposal is required');
      try {
        const planned = await editPlanner({
          request,
          initialProposal: result.documentProposal,
          previousTurn,
          usePreviousTurn: result.usedPreviousTurn === true,
          signal,
        });
        confirmation = await documentCoordinator.proposeEdit({ request, proposal: planned.proposal });
        nextDocumentContext = planned.documentContext;
      } catch (error) {
        const reasons = new Map([
          ['DOCUMENT_NOT_FOUND', `「${result.documentProposal.title}」がObsidianに見つからないため、変更候補を用意できませんでした。`],
          ['DOCUMENT_AMBIGUOUS', `「${result.documentProposal.title}」が複数あるため、変更候補を用意できませんでした。`],
          ['DOCUMENT_TEXT_NOT_FOUND', '指定された現在の文が見つからないため、変更候補を用意できませんでした。'],
          ['DOCUMENT_TEXT_AMBIGUOUS', '同じ文が複数あるため、変更する一箇所を特定できませんでした。'],
          ['DOCUMENT_EDIT_NEEDS_CLARIFICATION', error?.clarification || '変更する文書または内容を一つ確認してください。'],
        ]);
        if (!reasons.has(error?.code)) throw error;
        text = reasons.get(error.code);
        operation = 'none';
        completed = false;
      }
    } else if (operation === 'save_document_to_google_drive') {
      if (!result.documentProposal) throw new Error('Google Drive document proposal is required');
      confirmation = documentCoordinator.proposeGoogleDrive({ request, proposal: result.documentProposal });
    } else if (operation !== 'none' || result.documentProposal) {
      throw new Error('one-turn voice agent returned an unsafe operation');
    }
    const record = await recordConversation({
      request,
      answer: text,
      usedPreviousTurn: result.usedPreviousTurn === true,
      completed,
    });
    if (record?.recorded !== true) throw new Error('conversation was not recorded');
    previousTurn = completed
      ? Object.freeze({
        request,
        answer: text,
        ...(nextDocumentContext ? { documentContext: nextDocumentContext } : {}),
      })
      : null;
    return {
      text,
      requestText: request,
      completed,
      requestHandledAs: 'free_conversation_turn',
      usedPreviousTurn: result.usedPreviousTurn === true,
      conversationRecorded: true,
      changed: false,
      ephemeral: true,
      elapsedMs: Date.now() - startedAt,
      operation,
      ...(confirmation?.response ?? {}),
    };
  };
  processVoice.legacyMode = true;
  processVoice.close = async () => {};
  return processVoice;
}

export function createOneTurnVoiceProcessor(options = {}) {
  if (typeof options.agent === 'function') {
    return createLegacyOneTurnVoiceProcessor({
      transcribe: options.transcribe ?? transcribePcm,
      agent: options.agent,
      recordConversation: options.recordConversation ?? appendConversationRecord,
      documentCoordinator: options.documentCoordinator ?? createNewDocumentCoordinator(),
      editPlanner: options.editPlanner ?? planDocumentEdit,
    });
  }

  const transcribe = options.transcribe ?? transcribePcm;
  const recordConversation = options.recordConversation ?? appendConversationRecord;
  const conversation = options.conversation ??
    (options.createConversation ?? createCodexConversationSession)(options.conversationOptions);
  const documentCoordinator = options.documentCoordinator ?? createNewDocumentCoordinator();
  if (typeof transcribe !== 'function') throw new Error('transcriber is required');
  if (typeof recordConversation !== 'function') throw new Error('conversation recorder is required');
  if (!conversation || typeof conversation.send !== 'function' || typeof conversation.close !== 'function') {
    throw new Error('Codex conversation session is required');
  }

  let turnCount = 0;
  let closed = false;
  const processVoice = async (pcm, { signal } = {}) => {
    if (closed) throw new Error('voice conversation is closed');
    const startedAt = Date.now();
    const transcript = await transcribe(pcm, { signal });
    throwIfAborted(signal);
    const request = normalizeOneTurnRequest(transcript?.text);
    const result = await conversation.send(request, { signal });
    throwIfAborted(signal);
    let text = String(result?.message ?? '').normalize('NFKC').trim();
    if (!text || text.length > 240) throw new Error('Codex conversation answer must be 1 to 240 characters');
    if (typeof result.needsUserInput !== 'boolean') {
      throw new Error('Codex conversation input state is required');
    }
    const usedPreviousTurn = turnCount > 0;
    let needsUserInput = result.needsUserInput;
    let effectProposal = result.effectProposal ?? null;
    if (effectProposal) {
      try {
        effectProposal = await prepareEffectConfirmation({
          request,
          proposal: effectProposal,
          documentCoordinator,
        });
      } catch (error) {
        const stopped = stoppedEffectResponse(error);
        if (!stopped) throw error;
        text = stopped.text;
        needsUserInput = stopped.needsUserInput;
        effectProposal = null;
      }
    }
    const completed = !needsUserInput && effectProposal === null;
    const record = await recordConversation({
      request,
      answer: text,
      usedPreviousTurn,
      completed,
    });
    if (record?.recorded !== true) throw new Error('conversation was not recorded');
    turnCount += 1;
    return Object.freeze({
      text,
      requestText: request,
      completed,
      requestHandledAs: 'codex_conversation_turn',
      needsUserInput,
      usedPreviousTurn,
      conversationRecorded: true,
      changed: false,
      sessionScoped: true,
      effectProposal,
      elapsedMs: Date.now() - startedAt,
    });
  };
  processVoice.legacyMode = false;
  processVoice.close = async () => {
    if (closed) return;
    closed = true;
    await conversation.close();
  };
  return processVoice;
}

export function createOneTurnVoiceRelay(options = {}) {
  const legacyMode = typeof options.agent === 'function';
  const documentCoordinator = options.documentCoordinator ??
    createNewDocumentCoordinator();
  const processor = createOneTurnVoiceProcessor({
    ...options,
    documentCoordinator,
  });
  return createAudioRelay({
    token: options.token,
    port: options.port ?? 0,
    ttlMs: options.ttlMs ?? 300_000,
    maxRequests: Number.POSITIVE_INFINITY,
    transcribe: processor,
    exitOnFinish: options.exitOnFinish ?? false,
    allowIdleClose: true,
    extraJsonRoutes: legacyMode
      ? {
        '/v1/confirm-document': (input) => documentCoordinator.confirm(input),
        '/v1/cancel-document': (input) => documentCoordinator.cancel(input),
      }
      : {
        '/v1/confirm-effect': (input) => documentCoordinator.confirm(input),
        '/v1/cancel-effect': (input) => documentCoordinator.cancel(input),
      },
    onClose: () => processor.close(),
    resultPayload: legacyMode
      ? (result) => ({
        text: result.text,
        requestText: result.requestText,
        completed: result.completed,
        requestHandledAs: result.requestHandledAs,
        usedPreviousTurn: result.usedPreviousTurn,
        conversationRecorded: result.conversationRecorded,
        changed: result.changed,
        ephemeral: result.ephemeral,
        operation: result.operation,
        ...(['create_new_document', 'append_document', 'replace_document_text',
          'save_document_to_google_drive'].includes(result.operation) ? {
          documentProposal: result.documentProposal,
          ticketId: result.ticketId,
          candidateId: result.candidateId,
          confirmationToken: result.confirmationToken,
        } : {}),
      })
      : (result) => ({
        text: result.text,
        requestText: result.requestText,
        completed: result.completed,
        requestHandledAs: result.requestHandledAs,
        needsUserInput: result.needsUserInput,
        usedPreviousTurn: result.usedPreviousTurn,
        conversationRecorded: result.conversationRecorded,
        changed: result.changed,
        sessionScoped: result.sessionScoped,
        effectProposal: result.effectProposal,
      }),
  });
}

async function prepareEffectConfirmation({ request, proposal, documentCoordinator }) {
  let pending;
  if (proposal.action === 'create_obsidian_markdown') {
    pending = documentCoordinator.propose({
      request,
      proposal: { title: proposal.title, body: proposal.body, targetHint: DOCUMENT_TARGET_HINT },
    });
  } else if (proposal.action === 'replace_obsidian_text') {
    pending = await documentCoordinator.proposeEdit({
      request,
      proposal: {
        title: proposal.title,
        matchText: proposal.currentText,
        replacementText: proposal.replacementText,
        targetHint: OBSIDIAN_EDIT_TARGET_HINT,
        ...(proposal.resolvedPath ? { resolvedPath: proposal.resolvedPath } : {}),
      },
    });
  } else if (proposal.action === 'create_google_doc') {
    pending = documentCoordinator.proposeGoogleDrive({
      request,
      proposal: { title: proposal.title, body: proposal.body, targetHint: GOOGLE_DRIVE_TARGET_HINT },
    });
  } else {
    throw new Error('effect action is not allowed');
  }
  const document = pending.response.documentProposal;
  return Object.freeze({
    summary: pending.candidate.summary,
    details: effectDetails(document),
    action: document.action ?? 'create',
    title: document.title,
    targetHint: document.targetHint,
    preview: document.preview,
    ticketId: pending.response.ticketId,
    candidateId: pending.response.candidateId,
    confirmationToken: pending.response.confirmationToken,
  });
}

function effectDetails(document) {
  const label = document.action === 'replace_text' ? '変更内容' : '内容';
  return `対象: ${document.targetHint}\n題名: ${document.title}\n${label}: ${document.preview}`;
}

function stoppedEffectResponse(error) {
  const reasons = new Map([
    ['DOCUMENT_NOT_FOUND', '対象の文書を一つ確認できなかったため、まだ変更していません。文書名または保存場所を教えてください。'],
    ['DOCUMENT_AMBIGUOUS', '同じ題名の文書が複数あるため、まだ変更していません。保存場所も教えてください。'],
    ['DOCUMENT_TEXT_NOT_FOUND', '指定された現在の文が見つからないため、まだ変更していません。変更したい箇所を確認してください。'],
    ['DOCUMENT_TEXT_AMBIGUOUS', '同じ文が複数あるため、まだ変更していません。変更する箇所をもう少し長く教えてください。'],
  ]);
  if (!reasons.has(error?.code)) return null;
  return Object.freeze({ text: reasons.get(error.code), needsUserInput: true });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  throw error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.ROKID_VOICE_KNOWLEDGE_TOKEN ?? '';
  const port = Number(process.env.ROKID_VOICE_KNOWLEDGE_PORT ?? 18448);
  const ttlMs = Number(process.env.ROKID_VOICE_KNOWLEDGE_TTL_MS ?? 300_000);
  let relay = null;
  let stopping = false;
  const stopForSignal = async () => {
    if (stopping) return;
    stopping = true;
    await relay?.close().catch((error) => {
      console.error(`CLOSE_FAILED reason=signal error=${error.message}`);
    });
    process.exit(130);
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  try {
    relay = createOneTurnVoiceRelay({ token, port, ttlMs, exitOnFinish: true });
    const address = await relay.listen();
    console.log(
      `READY http://${address.host}:${address.port}/v1/transcribe ` +
      `ttlMs=${ttlMs} maxRequests=unlimited mode=codex-conversation-voice`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
