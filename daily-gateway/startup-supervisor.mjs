import { createFixedDailySessionController } from './fixed-session-controller.mjs';

export const DAILY_APP_OPEN_EVENT = 'daily_app_opened';
export const DEFAULT_APP_OPEN_MAX_AGE_MS = 10_000;
const ALLOWED_CLOCK_SKEW_MS = 2_000;

function validateAppOpenEvent(event, now, maxAgeMs) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('app-open event must be an object');
  }
  if (Object.keys(event).sort().join(',') !== 'observedAt,type') {
    throw new Error('app-open event has unexpected fields');
  }
  if (event.type !== DAILY_APP_OPEN_EVENT) throw new Error('invalid app-open event type');
  if (!Number.isSafeInteger(event.observedAt)) throw new Error('invalid app-open event time');
  const ageMs = now - event.observedAt;
  if (ageMs < -ALLOWED_CLOCK_SKEW_MS) throw new Error('app-open event is from the future');
  if (ageMs > maxAgeMs) throw new Error('app-open event is stale');
}

function publicReadiness(session, reused) {
  return Object.freeze({
    status: 'ready',
    origin: session.origin,
    expiresAt: session.expiresAt,
    reused,
    executionCapability: 'none',
    changed: false,
  });
}

function validatePreparedSession(session, currentTime) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('daily session must be an object');
  }
  if (typeof session.origin !== 'string' || !session.origin.startsWith('https://')) {
    throw new Error('daily session origin is invalid');
  }
  if (typeof session.token !== 'string' || Buffer.byteLength(session.token, 'utf8') < 32) {
    throw new Error('daily session token is invalid');
  }
  if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= currentTime) {
    throw new Error('daily session expiry is invalid');
  }
  if (!session.completion || typeof session.completion.then !== 'function') {
    throw new Error('daily session completion is invalid');
  }
}

export function createDailyStartupSupervisor(options = {}) {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_APP_OPEN_MAX_AGE_MS;
  const createController = options.createController ?? createFixedDailySessionController;
  if (typeof now !== 'function' || typeof createController !== 'function') {
    throw new Error('startup supervisor dependencies are required');
  }
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 60_000) {
    throw new Error('invalid app-open maximum age');
  }

  let active = null;
  let starting = null;

  function watchCompletion(record) {
    Promise.resolve(record.session.completion).finally(() => {
      if (active === record) active = null;
    }).catch(() => {});
  }

  async function startSession() {
    let controller = null;
    let record = null;
    try {
      controller = createController();
      const session = await controller.start();
      validatePreparedSession(session, now());
      record = { controller, session, connectionClaimed: false };
      active = record;
      watchCompletion(record);
      return publicReadiness(session, false);
    } catch (error) {
      if (active === record) active = null;
      await controller?.stop?.('supervisor_start_failed').catch(() => {});
      throw error;
    }
  }

  async function appOpened(event) {
    validateAppOpenEvent(event, now(), maxAgeMs);
    if (active && now() < active.session.expiresAt) {
      return publicReadiness(active.session, true);
    }
    if (active) {
      const expired = active;
      active = null;
      await expired.controller.stop('supervisor_expired');
    }
    if (starting) {
      const readiness = await starting;
      return Object.freeze({ ...readiness, reused: true });
    }
    starting = startSession();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  function claimShortLivedConnection() {
    if (!active || now() >= active.session.expiresAt) {
      throw new Error('no ready daily session');
    }
    if (active.connectionClaimed) throw new Error('daily session connection already claimed');
    active.connectionClaimed = true;
    return Object.freeze({
      origin: active.session.origin,
      token: active.session.token,
      expiresAt: active.session.expiresAt,
    });
  }

  async function stop(reason = 'requested') {
    if (starting) await starting.catch(() => {});
    if (!active) return { stopped: true, reason };
    const record = active;
    active = null;
    return record.controller.stop(`supervisor_${reason}`);
  }

  function state() {
    if (starting) return 'starting';
    if (active && now() < active.session.expiresAt) return 'ready';
    return 'idle';
  }

  return { appOpened, claimShortLivedConnection, stop, state };
}
