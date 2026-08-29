import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_DRY_RUN_TTL_MS = 15_000;
const DEFAULT_EXECUTION_TTL_MS = 15_000;
const MAX_TTL_MS = 600_000;

function boundedText(value, maximum, field, { allowEmpty = false, allowLineBreaks = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const controls = allowLineBreaks
    ? /[\u0000-\u0009\u000b-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if ((!allowEmpty && !text) || text.length > maximum || controls.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function candidateConfirmationBinding(candidate) {
  if (!candidate || candidate.disposition !== 'propose_action' ||
      candidate.confirmationRequired !== true ||
      candidate.allowedNextStep !== 'preview_only' ||
      candidate.executionCapability !== 'none' || candidate.changed !== false) {
    throw new Error('candidate is not an unexecuted confirmation-required preview');
  }
  const candidateId = boundedText(candidate.candidateId, 128, 'candidate_id');
  const sourceTextSha256 = boundedText(candidate.sourceTextSha256, 64, 'source_text_sha256');
  if (!/^[a-f0-9]{64}$/.test(sourceTextSha256)) {
    throw new Error('source_text_sha256 is invalid');
  }
  const actionType = boundedText(candidate.actionType, 48, 'action_type');
  const targetScope = boundedText(candidate.targetScope, 48, 'target_scope');
  const risk = boundedText(candidate.risk, 16, 'risk');
  const summary = boundedText(candidate.summary, 160, 'summary');
  const targetHint = boundedText(candidate.targetHint, 160, 'target_hint', { allowEmpty: true });
  const payloadPreview = boundedText(candidate.payloadPreview, 500, 'payload_preview', {
    allowEmpty: true,
    allowLineBreaks: true,
  });
  const resourceVersion = boundedText(candidate.resourceVersion, 64, 'resource_version', { allowEmpty: true });
  if (resourceVersion && !/^[a-f0-9]{64}$/.test(resourceVersion)) {
    throw new Error('resource_version is invalid');
  }
  const digest = sha256(JSON.stringify({
    bindingVersion: 3,
    candidateId,
    sourceTextSha256,
    actionType,
    targetScope,
    risk,
    summary,
    targetHint,
    payloadPreview,
    resourceVersion,
  }));
  return {
    bindingVersion: 3,
    candidateId,
    sourceTextSha256,
    actionType,
    targetScope,
    risk,
    summary,
    targetHint,
    payloadPreview,
    resourceVersion,
    digest,
  };
}

function secureTokenMatches(expectedHash, suppliedToken) {
  const actualHash = sha256(String(suppliedToken ?? ''));
  return timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(actualHash, 'hex'));
}

export class ConfirmationTicketStore {
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.ticketIdFactory = options.ticketIdFactory ?? randomUUID;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > MAX_TTL_MS) {
      throw new Error('ttl_ms must be between 1000 and 600000');
    }
    this.dryRunTtlMs = options.dryRunTtlMs ?? DEFAULT_DRY_RUN_TTL_MS;
    if (!Number.isInteger(this.dryRunTtlMs) || this.dryRunTtlMs < 1_000 || this.dryRunTtlMs > MAX_TTL_MS) {
      throw new Error('dry_run_ttl_ms must be between 1000 and 600000');
    }
    this.executionTtlMs = options.executionTtlMs ?? DEFAULT_EXECUTION_TTL_MS;
    if (!Number.isInteger(this.executionTtlMs) || this.executionTtlMs < 1_000 || this.executionTtlMs > MAX_TTL_MS) {
      throw new Error('execution_ttl_ms must be between 1000 and 600000');
    }
    this.records = new Map();
  }

  issue(candidate) {
    const now = this.clock();
    this.expireAt(now);
    if ([...this.records.values()].some((record) => record.status === 'pending')) {
      throw new Error('only one confirmation ticket may be pending');
    }
    const binding = candidateConfirmationBinding(candidate);
    const ticketId = boundedText(this.ticketIdFactory(), 128, 'ticket_id');
    const confirmationToken = boundedText(this.tokenFactory(), 256, 'confirmation_token');
    if (this.records.has(ticketId)) throw new Error('ticket_id already exists');
    const record = {
      ticketId,
      candidateId: binding.candidateId,
      candidateDigest: binding.digest,
      bindingVersion: binding.bindingVersion,
      sourceTextSha256: binding.sourceTextSha256,
      actionType: binding.actionType,
      targetScope: binding.targetScope,
      risk: binding.risk,
      tokenHash: sha256(confirmationToken),
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      status: 'pending',
      decidedAt: null,
      dryRunSimulationId: null,
      dryRunAttemptedAt: null,
      dryRunExpiresAt: null,
      executionId: null,
      executionAttemptedAt: null,
      executionExpiresAt: null,
    };
    this.records.set(ticketId, record);
    return {
      ticketId,
      candidateId: record.candidateId,
      candidateDigest: record.candidateDigest,
      confirmationToken,
      expiresAt: record.expiresAt,
      allowedNextStep: 'confirmation_only',
      executionCapability: 'none',
    };
  }

  confirm(input) {
    return this.decide(input, 'confirmed');
  }

  cancel(input) {
    return this.decide(input, 'cancelled');
  }

  decide(input, decision) {
    const now = this.clock();
    this.expireAt(now);
    const ticketId = boundedText(input?.ticketId, 128, 'ticket_id');
    const candidateId = boundedText(input?.candidateId, 128, 'candidate_id');
    const record = this.records.get(ticketId);
    if (!record || record.candidateId !== candidateId ||
        !secureTokenMatches(record?.tokenHash ?? sha256('missing'), input?.confirmationToken)) {
      return this.rejection('invalid_ticket');
    }
    if (record.status !== 'pending') return this.rejection(record.status);
    if (now >= record.expiresAt) {
      record.status = 'expired';
      record.decidedAt = now;
      return this.rejection('expired');
    }
    record.status = decision;
    record.decidedAt = now;
    record.dryRunExpiresAt = decision === 'confirmed'
      ? Math.min(record.expiresAt, now + this.dryRunTtlMs)
      : null;
    record.executionExpiresAt = decision === 'confirmed' &&
      ['create_new_document', 'append_document', 'replace_document_text',
        'save_document_to_google_drive'].includes(record.actionType)
      ? Math.min(record.expiresAt, now + this.executionTtlMs)
      : null;
    return {
      accepted: true,
      status: decision,
      ticketId: record.ticketId,
      candidateId: record.candidateId,
      candidateDigest: record.candidateDigest,
      confirmationRecorded: decision === 'confirmed',
      protectedResourceChanged: false,
      allowedNextStep: 'record_only',
      executionCapability: 'none',
    };
  }

  rejection(reason) {
    return {
      accepted: false,
      reason,
      confirmationRecorded: false,
      protectedResourceChanged: false,
      allowedNextStep: 'none',
      executionCapability: 'none',
    };
  }

  claimDryRun(input) {
    const now = this.clock();
    this.expireAt(now);
    let ticketId;
    let simulationId;
    try {
      ticketId = boundedText(input?.ticketId, 128, 'ticket_id');
      simulationId = boundedText(input?.simulationId, 128, 'simulation_id');
    } catch {
      return this.dryRunRejection('invalid_ticket');
    }
    let binding;
    try {
      binding = candidateConfirmationBinding(input?.candidate);
    } catch {
      return this.dryRunRejection('invalid_candidate');
    }
    const record = this.records.get(ticketId);
    if (!record) return this.dryRunRejection('invalid_ticket');
    if (record.status !== 'confirmed') return this.dryRunRejection(record.status);
    if (now >= record.dryRunExpiresAt) return this.dryRunRejection('confirmation_expired');
    if (record.candidateId !== binding.candidateId || record.candidateDigest !== binding.digest) {
      return this.dryRunRejection('candidate_mismatch');
    }
    if (record.dryRunAttemptedAt !== null) return this.dryRunRejection('already_simulated');
    record.dryRunSimulationId = simulationId;
    record.dryRunAttemptedAt = now;
    return {
      authorized: true,
      ticketId: record.ticketId,
      candidateId: record.candidateId,
      candidateDigest: record.candidateDigest,
      bindingVersion: record.bindingVersion,
      simulationId,
      dryRunExpiresAt: record.dryRunExpiresAt,
      protectedResourceChanged: false,
      executionCapability: 'none',
    };
  }

  dryRunRejection(reason) {
    return {
      authorized: false,
      reason,
      protectedResourceChanged: false,
      executionCapability: 'none',
    };
  }

  claimCreateDocument(input) {
    return this.claimDocumentExecution(input, 'create_new_document');
  }

  claimAppendDocument(input) {
    return this.claimDocumentExecution(input, 'append_document');
  }

  claimReplaceDocumentText(input) {
    return this.claimDocumentExecution(input, 'replace_document_text');
  }

  claimSaveGoogleDriveDocument(input) {
    return this.claimDocumentExecution(input, 'save_document_to_google_drive');
  }

  claimDocumentExecution(input, expectedActionType) {
    const now = this.clock();
    this.expireAt(now);
    let ticketId;
    let executionId;
    try {
      ticketId = boundedText(input?.ticketId, 128, 'ticket_id');
      executionId = boundedText(input?.executionId, 128, 'execution_id');
    } catch {
      return this.executionRejection('invalid_ticket');
    }
    let binding;
    try {
      binding = candidateConfirmationBinding(input?.candidate);
    } catch {
      return this.executionRejection('invalid_candidate');
    }
    const record = this.records.get(ticketId);
    if (!record) return this.executionRejection('invalid_ticket');
    if (record.status !== 'confirmed') return this.executionRejection(record.status);
    const expectedTargetScope = expectedActionType === 'save_document_to_google_drive'
      ? 'google_drive'
      : 'obsidian';
    if (record.actionType !== expectedActionType || record.targetScope !== expectedTargetScope) {
      return this.executionRejection('unsupported_action');
    }
    if (!record.executionExpiresAt || now >= record.executionExpiresAt) {
      return this.executionRejection('confirmation_expired');
    }
    if (record.candidateId !== binding.candidateId || record.candidateDigest !== binding.digest) {
      return this.executionRejection('candidate_mismatch');
    }
    if (record.executionAttemptedAt !== null) return this.executionRejection('already_executed');
    record.executionId = executionId;
    record.executionAttemptedAt = now;
    return {
      authorized: true,
      ticketId: record.ticketId,
      candidateId: record.candidateId,
      candidateDigest: record.candidateDigest,
      bindingVersion: record.bindingVersion,
      executionId,
      executionExpiresAt: record.executionExpiresAt,
      protectedResourceChanged: false,
      executionCapability: expectedActionType,
    };
  }

  executionRejection(reason) {
    return {
      authorized: false,
      reason,
      protectedResourceChanged: false,
      executionCapability: 'none',
    };
  }

  expireAt(now) {
    for (const record of this.records.values()) {
      if (record.status === 'pending' && now >= record.expiresAt) {
        record.status = 'expired';
        record.decidedAt = now;
      }
    }
  }

  auditRecords() {
    this.expireAt(this.clock());
    return [...this.records.values()].map((record) => ({
      ticketId: record.ticketId,
      candidateId: record.candidateId,
      candidateDigest: record.candidateDigest,
      bindingVersion: record.bindingVersion,
      sourceTextSha256: record.sourceTextSha256,
      actionType: record.actionType,
      targetScope: record.targetScope,
      risk: record.risk,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      status: record.status,
      decidedAt: record.decidedAt,
      dryRunSimulationId: record.dryRunSimulationId,
      dryRunAttemptedAt: record.dryRunAttemptedAt,
      dryRunExpiresAt: record.dryRunExpiresAt,
      executionId: record.executionId,
      executionAttemptedAt: record.executionAttemptedAt,
      executionExpiresAt: record.executionExpiresAt,
      protectedResourceChanged: false,
    }));
  }
}
