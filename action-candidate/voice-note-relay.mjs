import { createHash, randomUUID } from 'node:crypto';

import { createAudioRelay, transcribePcm } from '../aiui-knowledge-bridge/audio-relay.mjs';
import { ConfirmationTicketStore } from './confirmation-ticket.mjs';
import { applyConfirmedCandidate } from './trial-note-adapter.mjs';

const MAX_TRANSCRIPT_CHARACTERS = 240;

export function candidateFromTranscript(value, { candidateId = randomUUID() } = {}) {
  const transcript = String(value ?? '').trim();
  if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARACTERS || /[\u0000-\u001f\u007f]/.test(transcript) || /<!--|-->/.test(transcript)) {
    throw new Error('invalid_transcript');
  }
  return {
    candidateId,
    sourceTextSha256: createHash('sha256').update(transcript).digest('hex'),
    disposition: 'propose_action',
    actionType: 'create_or_append_note',
    targetScope: 'obsidian',
    risk: 'low',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: '発話内容を試用メモへ保存',
    targetHint: 'Rokid個人AIの試用メモ',
    payloadPreview: transcript,
  };
}

export function createVoiceNoteRelay({
  token,
  port = 0,
  ttlMs = 600_000,
  confirmationTtlMs = 300_000,
  transcribe = transcribePcm,
  apply = applyConfirmedCandidate,
  targetPath,
  onDecision = () => {},
} = {}) {
  const store = new ConfirmationTicketStore({ ttlMs: confirmationTtlMs });
  let current = null;

  const relay = createAudioRelay({
    token,
    port,
    ttlMs,
    maxRequests: 1,
    exitOnFinish: false,
    async transcribe(pcm, { signal }) {
      const startedAt = Date.now();
      const result = await transcribe(pcm, { signal });
      const candidate = candidateFromTranscript(result?.text);
      const ticket = store.issue(candidate);
      current = { candidate, ticket };
      return {
        text: candidate.payloadPreview,
        ticketId: ticket.ticketId,
        candidateId: ticket.candidateId,
        confirmationToken: ticket.confirmationToken,
        expiresAt: ticket.expiresAt,
        elapsedMs: Date.now() - startedAt,
      };
    },
    resultPayload(result) {
      return {
        text: result.text,
        ticketId: result.ticketId,
        candidateId: result.candidateId,
        confirmationToken: result.confirmationToken,
        expiresAt: result.expiresAt,
      };
    },
    extraJsonRoutes: {
      '/v1/confirm-note': async (input) => decide('confirmed', input),
      '/v1/cancel-note': async (input) => decide('cancelled', input),
    },
  });

  async function decide(status, input) {
    if (!current) return { status: 409, payload: { ok: false, error: 'no_transcript' } };
    const allowed = new Set(['ticketId', 'candidateId', 'confirmationToken']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
      return { status: 400, payload: { ok: false, error: 'invalid_ticket' } };
    }
    const decision = status === 'confirmed' ? store.confirm(input) : store.cancel(input);
    if (!decision.accepted) {
      return { status: decision.reason === 'expired' ? 410 : 409, payload: { ok: false, ...decision } };
    }
    const applied = status === 'confirmed'
      ? await apply(current.candidate, decision, targetPath ? { targetPath } : {})
      : { applied: false, changed: false, state: 'cancelled', text: '取り消しました' };
    const outcome = { ...decision, ...applied, transcript: current.candidate.payloadPreview };
    await onDecision(outcome);
    return { status: 200, payload: { ok: true, ...outcome } };
  }

  return { ...relay, store };
}
