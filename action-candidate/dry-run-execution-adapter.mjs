import { randomUUID } from 'node:crypto';

import { candidateConfirmationBinding } from './confirmation-ticket.mjs';

function rejection(reason, simulationId = null) {
  return {
    accepted: false,
    reason,
    simulationId,
    changed: false,
    protectedResourceChanged: false,
    sideEffectCount: 0,
    allowedNextStep: 'none',
    executionCapability: 'none',
  };
}

export class DryRunExecutionAdapter {
  constructor(options = {}) {
    if (!options.store || typeof options.store.claimDryRun !== 'function') {
      throw new Error('confirmation store is required');
    }
    this.store = options.store;
    this.simulationIdFactory = options.simulationIdFactory ?? randomUUID;
  }

  simulate(input) {
    let binding;
    let simulationId;
    try {
      binding = candidateConfirmationBinding(input?.candidate);
      simulationId = String(this.simulationIdFactory()).normalize('NFKC').trim();
      if (!simulationId || simulationId.length > 128 || /[\u0000-\u001f\u007f]/.test(simulationId)) {
        return rejection('invalid_simulation_id');
      }
    } catch {
      return rejection('invalid_candidate');
    }

    const authorization = this.store.claimDryRun({
      ticketId: input?.ticketId,
      candidate: input?.candidate,
      simulationId,
    });
    if (!authorization.authorized) return rejection(authorization.reason, simulationId);

    return {
      accepted: true,
      status: 'simulated',
      simulationId,
      ticketId: authorization.ticketId,
      candidateId: authorization.candidateId,
      candidateDigest: authorization.candidateDigest,
      bindingVersion: authorization.bindingVersion,
      dryRunExpiresAt: authorization.dryRunExpiresAt,
      preview: {
        actionType: binding.actionType,
        targetScope: binding.targetScope,
        targetHint: binding.targetHint,
        summary: binding.summary,
        payloadPreview: binding.payloadPreview,
        risk: binding.risk,
      },
      changed: false,
      protectedResourceChanged: false,
      sideEffectCount: 0,
      allowedNextStep: 'none',
      executionCapability: 'none',
    };
  }
}
