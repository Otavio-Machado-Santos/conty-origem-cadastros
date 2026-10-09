import { MemoryStore } from './storage.js';

export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const TYPES = new Set(['campaign', 'referral', 'community']);
const iso = milliseconds => new Date(milliseconds).toISOString();
const time = timestamp => Date.parse(timestamp);
const compareIds = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const compareTouches = (left, right) => time(right.touchedAt) - time(left.touchedAt)
  || compareIds(left.clickId, right.clickId);

export class AttributionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new AttributionError(status, code, message); }
function identifier(value, field) {
  if (!validId(value)) {
    fail(400, 'invalid_input', `${field} must contain 1–120 ASCII letters, digits, _ or -`);
  }
  return value;
}
function fields(input, allowed, required = allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'invalid_input', 'A JSON object is required');
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) fail(400, 'unknown_field', `Unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) fail(400, 'invalid_input', `Missing field: ${key}`);
  }
}
function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(time(value)) && iso(time(value)) === value;
}

function assertState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.links)
    || !Array.isArray(state.installations)) throw new Error('Unsupported or invalid attribution store');
  const linkIds = new Set();
  const installationIds = new Set();
  const clickIds = new Set();
  const signupIds = new Set();
  for (const link of state.links) {
    if (!link || !validId(link.id) || !validId(link.sourceId) || !TYPES.has(link.type)
      || linkIds.has(link.id) || link.url !== `conty://open?link_id=${encodeURIComponent(link.id)}`) {
      throw new Error('Invalid stored link');
    }
    linkIds.add(link.id);
  }
  for (const installation of state.installations) {
    if (!installation || !validId(installation.id) || installationIds.has(installation.id)
      || !timestamp(installation.firstOpenedAt) || !timestamp(installation.windowEndsAt)
      || !timestamp(installation.lastObservedAt) || !Array.isArray(installation.touches)
      || time(installation.windowEndsAt) < time(installation.firstOpenedAt)
      || time(installation.lastObservedAt) < time(installation.firstOpenedAt)) {
      throw new Error('Invalid stored installation');
    }
    installationIds.add(installation.id);
    for (const touch of installation.touches) {
      if (!touch || !validId(touch.clickId) || clickIds.has(touch.clickId)
        || !linkIds.has(touch.linkId) || !timestamp(touch.touchedAt)
        || time(touch.touchedAt) < time(installation.firstOpenedAt)
        || time(touch.touchedAt) > time(installation.lastObservedAt)
        || typeof touch.recordedAfterSignup !== 'boolean') throw new Error('Invalid stored touch');
      clickIds.add(touch.clickId);
    }
    if (installation.signup) {
      const signup = installation.signup;
      if (!validId(signup.id) || signupIds.has(signup.id) || !timestamp(signup.registeredAt)
        || time(signup.registeredAt) < time(installation.firstOpenedAt)
        || time(signup.registeredAt) > time(installation.lastObservedAt)
        || !signup.origin || typeof signup.origin.reason !== 'string'
        || !['organic', ...TYPES].includes(signup.origin.type)) throw new Error('Invalid stored signup');
      if (signup.origin.type !== 'organic') {
        const winner = installation.touches.find(touch => touch.clickId === signup.origin.clickId);
        const link = state.links.find(item => item.id === winner?.linkId);
        if (!winner || winner.recordedAfterSignup || time(winner.touchedAt) > time(signup.registeredAt)
          || time(signup.registeredAt) > time(installation.windowEndsAt)
          || signup.origin.type !== link.type || signup.origin.sourceId !== link.sourceId
          || signup.origin.linkId !== link.id || signup.origin.touchedAt !== winner.touchedAt
          || signup.origin.reason !== 'last_eligible_touch') throw new Error('Stored winning touch is inconsistent');
      } else if (!['no_touch', 'no_eligible_touch', 'attribution_window_expired'].includes(signup.origin.reason)) {
        throw new Error('Stored organic reason is invalid');
      }
      signupIds.add(signup.id);
    } else if (installation.touches.some(touch => touch.recordedAfterSignup)) {
      throw new Error('Late touch has no signup');
    }
  }
}

/** First open and event times come from the server clock, never from link query parameters. */
export class AttributionService {
  #state;
  #store;
  #clock;

  constructor({ store = new MemoryStore(), clock = () => new Date(), windowMs = DEFAULT_WINDOW_MS } = {}) {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error('windowMs must be a positive safe integer');
    this.windowMs = windowMs;
    this.#clock = clock;
    this.#store = store;
    this.#state = store.load();
    assertState(this.#state);
  }

  #now(installation) {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      fail(503, 'invalid_clock', 'Server clock must return a valid Date');
    }
    if (installation && value.getTime() < time(installation.lastObservedAt)) {
      fail(503, 'clock_regression', 'Server clock moved backwards; no event was accepted');
    }
    return value.getTime();
  }

  #change(mutator) {
    const state = structuredClone(this.#state);
    const result = mutator(state);
    this.#store.save(state);
    this.#state = state;
    return structuredClone(result);
  }

  #installation(id, state = this.#state) {
    identifier(id, 'installationId');
    const installation = state.installations.find(item => item.id === id);
    if (!installation) fail(404, 'installation_not_found', 'Open the app before recording touches or signing up');
    return installation;
  }

  #link(id) {
    identifier(id, 'linkId');
    const link = this.#state.links.find(item => item.id === id);
    if (!link) fail(404, 'link_not_found', 'Unknown linkId');
    return link;
  }

  #click(clickId) {
    for (const installation of this.#state.installations) {
      const touch = installation.touches.find(item => item.clickId === clickId);
      if (touch) return { installation, touch };
    }
  }

  #touchInput(input) {
    fields(input, ['clickId', 'linkId']);
    identifier(input.clickId, 'clickId');
    this.#link(input.linkId);
  }

  #replay(installationId, input) {
    const existing = this.#click(input.clickId);
    if (!existing) return;
    if (existing.installation.id !== installationId || existing.touch.linkId !== input.linkId) {
      fail(409, 'click_conflict', 'clickId already belongs to another installation or link');
    }
    return structuredClone(existing.touch);
  }

  createLink(input) {
    fields(input, ['id', 'type', 'sourceId']);
    identifier(input.id, 'id');
    identifier(input.sourceId, 'sourceId');
    if (!TYPES.has(input.type)) fail(400, 'invalid_input', 'type must be campaign, referral or community');
    const existing = this.#state.links.find(link => link.id === input.id);
    if (existing) {
      if (existing.type !== input.type || existing.sourceId !== input.sourceId) {
        fail(409, 'link_conflict', 'Link ids are immutable');
      }
      return structuredClone(existing);
    }
    return this.#change(state => {
      const link = { id: input.id, type: input.type, sourceId: input.sourceId,
        url: `conty://open?link_id=${encodeURIComponent(input.id)}` };
      state.links.push(link);
      return link;
    });
  }

  openApp(installationId, input = {}) {
    identifier(installationId, 'installationId');
    fields(input, ['clickId', 'linkId'], []);
    const hasTouch = Object.hasOwn(input, 'clickId') || Object.hasOwn(input, 'linkId');
    if (hasTouch) this.#touchInput(input);
    const installation = this.#state.installations.find(item => item.id === installationId);
    if (hasTouch) {
      const replay = this.#replay(installationId, input);
      if (replay) return { installation: this.getInstallation(installationId), touch: replay, duplicate: true };
    }
    const now = this.#now(installation);
    if (!installation && !Number.isFinite(new Date(now + this.windowMs).getTime())) {
      fail(503, 'invalid_clock', 'Attribution window overflows the supported date range');
    }
    return this.#change(state => {
      let current = state.installations.find(item => item.id === installationId);
      if (!current) {
        current = { id: installationId, firstOpenedAt: iso(now), windowEndsAt: iso(now + this.windowMs),
          lastObservedAt: iso(now), touches: [], signup: null };
        state.installations.push(current);
      }
      current.lastObservedAt = iso(now);
      const touch = hasTouch ? this.#appendTouch(current, input, now) : null;
      return { installation: current, touch, duplicate: false };
    });
  }

  #appendTouch(installation, input, now) {
    const touch = { clickId: input.clickId, linkId: input.linkId, touchedAt: iso(now),
      recordedAfterSignup: Boolean(installation.signup) };
    installation.touches.push(touch);
    return touch;
  }

  recordTouch(installationId, input) {
    const installation = this.#installation(installationId);
    this.#touchInput(input);
    const replay = this.#replay(installationId, input);
    if (replay) return { touch: replay, duplicate: true };
    const now = this.#now(installation);
    return this.#change(state => {
      const current = this.#installation(installationId, state);
      current.lastObservedAt = iso(now);
      return { touch: this.#appendTouch(current, input, now), duplicate: false };
    });
  }

  signup(installationId, input) {
    const installation = this.#installation(installationId);
    fields(input, ['signupId']);
    identifier(input.signupId, 'signupId');
    const previous = this.#state.installations.find(item => item.signup?.id === input.signupId);
    if (previous && previous.id !== installationId) fail(409, 'signup_conflict', 'signupId already belongs to another installation');
    if (installation.signup) {
      if (installation.signup.id !== input.signupId) fail(409, 'signup_conflict', 'Installation already has a signup');
      return this.auditSignup(input.signupId);
    }
    const now = this.#now(installation);
    this.#change(state => {
      const current = this.#installation(installationId, state);
      const eligible = current.touches.filter(touch => !touch.recordedAfterSignup
        && time(touch.touchedAt) <= now && time(touch.touchedAt) <= time(current.windowEndsAt));
      eligible.sort(compareTouches);
      const expired = now > time(current.windowEndsAt);
      const winner = expired ? null : eligible[0];
      let origin;
      if (winner) {
        const link = this.#link(winner.linkId);
        origin = { type: link.type, sourceId: link.sourceId, linkId: link.id, clickId: winner.clickId,
          touchedAt: winner.touchedAt, reason: 'last_eligible_touch' };
      } else {
        origin = { type: 'organic', reason: expired ? 'attribution_window_expired'
          : current.touches.length ? 'no_eligible_touch' : 'no_touch' };
      }
      current.lastObservedAt = iso(now);
      current.signup = { id: input.signupId, registeredAt: iso(now), origin };
    });
    return this.auditSignup(input.signupId);
  }

  getInstallation(installationId) { return structuredClone(this.#installation(installationId)); }

  auditSignup(signupId) {
    identifier(signupId, 'signupId');
    const installation = this.#state.installations.find(item => item.signup?.id === signupId);
    if (!installation) fail(404, 'signup_not_found', 'Unknown signupId');
    const signup = installation.signup;
    const origin = signup.origin;
    const winner = installation.touches.find(touch => touch.clickId === origin.clickId);
    const touches = [...installation.touches].sort((a, b) => time(a.touchedAt) - time(b.touchedAt)
      || compareIds(a.clickId, b.clickId)).map(touch => {
      let reason;
      if (touch.recordedAfterSignup || time(touch.touchedAt) > time(signup.registeredAt)) reason = 'after_signup';
      else if (time(touch.touchedAt) > time(installation.windowEndsAt)) reason = 'outside_attribution_window';
      else if (origin.reason === 'attribution_window_expired') reason = 'signup_outside_attribution_window';
      else if (touch.clickId === origin.clickId) reason = 'winner';
      else if (winner && touch.touchedAt === winner.touchedAt) reason = 'tie_lost_to_click_id';
      else reason = 'superseded_by_more_recent_touch';
      const link = this.#link(touch.linkId);
      return { ...touch, type: link.type, sourceId: link.sourceId, won: reason === 'winner', reason };
    });
    return structuredClone({ signupId: signup.id, installationId: installation.id,
      registeredAt: signup.registeredAt, firstOpenedAt: installation.firstOpenedAt,
      windowEndsAt: installation.windowEndsAt, origin,
      rule: 'last eligible touch; ties: lexicographically smallest ASCII clickId', touches });
  }
}
