import test from 'node:test';
import assert from 'node:assert/strict';
import { AttributionService, DEFAULT_WINDOW_MS } from '../src/attribution.js';
import { MemoryStore } from '../src/storage.js';

const FIRST = Date.parse('2026-06-01T12:00:00.000Z');
function setup(options = {}) {
  let now = FIRST;
  const service = new AttributionService({ clock: () => new Date(now), ...options });
  service.createLink({ id: 'campaign-a', type: 'campaign', sourceId: 'summer' });
  service.createLink({ id: 'referral-b', type: 'referral', sourceId: 'creator42' });
  return { service, setTime: value => { now = typeof value === 'string' ? Date.parse(value) : value; } };
}
const open = service => service.openApp('app-1', { clickId: 'click-first', linkId: 'campaign-a' });
const register = service => service.signup('app-1', { signupId: 'signup-1' });
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

test('organic first open persists anchor and organic reason at signup', () => {
  const { service } = setup();
  service.openApp('app-1');
  const result = register(service);
  assert.deepEqual(result.origin, { type: 'organic', reason: 'no_touch' });
  assert.deepEqual(result.touches, []);
  assert.equal(service.getInstallation('app-1').signup.origin.reason, 'no_touch');
  assert.equal(result.firstOpenedAt, '2026-06-01T12:00:00.000Z');
});

test('open with explicit link payload works without referrer', () => {
  const { service } = setup();
  open(service);
  const result = register(service);
  assert.equal(result.origin.type, 'campaign');
  assert.equal(result.origin.sourceId, 'summer');
  assert.equal(result.touches[0].reason, 'winner');
});

test('two links before signup use last eligible touch and explain earlier loss', () => {
  const { service, setTime } = setup();
  open(service);
  setTime(FIRST + 1000);
  service.recordTouch('app-1', { clickId: 'click-second', linkId: 'referral-b' });
  const result = register(service);
  assert.equal(result.origin.clickId, 'click-second');
  assert.deepEqual(result.touches.map(touch => touch.reason), ['superseded_by_more_recent_touch', 'winner']);
});

test('timestamp ties choose smallest ASCII clickId regardless of arrival order', () => {
  for (const clicks of [['z-click', 'a-click'], ['a-click', 'z-click']]) {
    const { service } = setup();
    service.openApp('app-1');
    for (const clickId of clicks) service.recordTouch('app-1', {
      clickId, linkId: clickId === 'a-click' ? 'referral-b' : 'campaign-a',
    });
    const result = register(service);
    assert.equal(result.origin.clickId, 'a-click');
    assert.deepEqual(result.touches.map(touch => touch.reason), ['winner', 'tie_lost_to_click_id']);
  }
});

test('window includes exact final millisecond, both touch and signup', () => {
  const { service, setTime } = setup();
  service.openApp('app-1');
  setTime(FIRST + DEFAULT_WINDOW_MS);
  service.recordTouch('app-1', { clickId: 'at-boundary', linkId: 'campaign-a' });
  assert.equal(register(service).origin.clickId, 'at-boundary');
});

test('one millisecond beyond the window cannot win and stores organic expiry', () => {
  const { service, setTime } = setup();
  service.openApp('app-1');
  setTime(FIRST + DEFAULT_WINDOW_MS + 1);
  service.recordTouch('app-1', { clickId: 'outside', linkId: 'referral-b' });
  const result = register(service);
  assert.equal(result.origin.reason, 'attribution_window_expired');
  assert.equal(result.touches[0].reason, 'outside_attribution_window');
  assert.equal(result.touches[0].won, false);
});

test('an old valid touch expires if signup happens after the anchored window', () => {
  const { service, setTime } = setup();
  open(service);
  setTime(FIRST + DEFAULT_WINDOW_MS + 1);
  const result = register(service);
  assert.deepEqual(result.origin, { type: 'organic', reason: 'attribution_window_expired' });
  assert.equal(result.touches[0].reason, 'signup_outside_attribution_window');
});

test('reopen never resets first-open anchor, including an organic first opening', () => {
  const { service, setTime } = setup();
  service.openApp('app-1');
  setTime(FIRST + DEFAULT_WINDOW_MS - 10);
  service.openApp('app-1', { clickId: 'late-link', linkId: 'referral-b' });
  setTime(FIRST + DEFAULT_WINDOW_MS + 1);
  const result = register(service);
  assert.equal(result.firstOpenedAt, '2026-06-01T12:00:00.000Z');
  assert.equal(result.windowEndsAt, '2026-06-08T12:00:00.000Z');
  assert.equal(result.origin.type, 'organic');
});

test('same click replay is globally idempotent without extending its time', () => {
  const { service, setTime } = setup();
  const first = open(service);
  setTime(FIRST + 500);
  const repeated = service.openApp('app-1', { clickId: 'click-first', linkId: 'campaign-a' });
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.touch, first.touch);
  assert.equal(service.getInstallation('app-1').touches.length, 1);
  assert.equal(service.recordTouch('app-1', { clickId: 'click-first', linkId: 'campaign-a' }).duplicate, true);
  assert.equal(register(service).touches.length, 1);
});

test('same click with different payload or installation is rejected', () => {
  const { service } = setup();
  open(service);
  throwsCode(() => service.recordTouch('app-1', { clickId: 'click-first', linkId: 'referral-b' }), 'click_conflict');
  throwsCode(() => service.openApp('app-2', { clickId: 'click-first', linkId: 'campaign-a' }), 'click_conflict');
  throwsCode(() => service.getInstallation('app-2'), 'installation_not_found');
});

test('touches after signup are visible in audit but cannot replace original winner', () => {
  const { service, setTime } = setup();
  open(service);
  const before = register(service);
  setTime(FIRST + 1000);
  service.recordTouch('app-1', { clickId: 'new-referral', linkId: 'referral-b' });
  const after = service.auditSignup('signup-1');
  assert.deepEqual(after.origin, before.origin);
  assert.equal(after.touches.at(-1).reason, 'after_signup');
  assert.equal(after.touches.filter(touch => touch.won).length, 1);
});

test('same-millisecond touch received after signup still loses', () => {
  const { service } = setup();
  open(service);
  register(service);
  service.openApp('app-1', { clickId: 'a-new-earlier-id', linkId: 'referral-b' });
  const audit = service.auditSignup('signup-1');
  const late = audit.touches.find(touch => touch.clickId === 'a-new-earlier-id');
  assert.equal(late.reason, 'after_signup');
  assert.equal(audit.origin.clickId, 'click-first');
});

test('post-signup link cannot change an organic signup either', () => {
  const { service } = setup();
  service.openApp('app-1');
  register(service);
  service.recordTouch('app-1', { clickId: 'late', linkId: 'campaign-a' });
  const result = service.auditSignup('signup-1');
  assert.deepEqual(result.origin, { type: 'organic', reason: 'no_touch' });
  assert.equal(result.touches[0].reason, 'after_signup');
});

test('signup retries retain stored origin and ids cannot be reassigned', () => {
  const { service, setTime } = setup();
  open(service);
  const before = register(service);
  setTime(FIRST + DEFAULT_WINDOW_MS + 1);
  assert.deepEqual(register(service), before);
  throwsCode(() => service.signup('app-1', { signupId: 'other' }), 'signup_conflict');
  service.openApp('app-2');
  throwsCode(() => service.signup('app-2', { signupId: 'signup-1' }), 'signup_conflict');
});

test('clients cannot forge first-open dates, timestamps or referrer metadata', () => {
  const { service } = setup();
  for (const key of ['firstOpenedAt', 'touchedAt', 'occurredAt', 'referrer']) {
    throwsCode(() => service.openApp('app-1', { [key]: 'invalid' }), 'unknown_field');
  }
  open(service);
  throwsCode(() => service.recordTouch('app-1', {
    clickId: 'fake', linkId: 'campaign-a', touchedAt: '2020-01-01T00:00:00.000Z',
  }), 'unknown_field');
  throwsCode(() => service.signup('app-1', { signupId: 'signup-1', registeredAt: 'bad-date' }), 'unknown_field');
});

test('touch/signup before first open are rejected without inventing an anchor', () => {
  const { service } = setup();
  throwsCode(() => service.recordTouch('missing', { clickId: 'click', linkId: 'campaign-a' }), 'installation_not_found');
  throwsCode(() => service.signup('missing', { signupId: 'signup' }), 'installation_not_found');
});

test('invalid and regressing server clocks do not mutate state', () => {
  const { service, setTime } = setup();
  open(service);
  const before = service.getInstallation('app-1');
  setTime(FIRST - 1);
  throwsCode(() => service.recordTouch('app-1', { clickId: 'backdated', linkId: 'campaign-a' }), 'clock_regression');
  setTime(NaN);
  throwsCode(() => register(service), 'invalid_clock');
  assert.deepEqual(service.getInstallation('app-1'), before);
  const invalid = new AttributionService({ clock: () => '2026-06-01' });
  throwsCode(() => invalid.openApp('app'), 'invalid_clock');
});

test('link ids cannot change creator or kind after attribution', () => {
  const { service } = setup();
  const link = service.createLink({ id: 'referral-b', type: 'referral', sourceId: 'creator42' });
  assert.equal(link.url, 'conty://open?link_id=referral-b');
  throwsCode(() => service.createLink({ id: 'referral-b', type: 'campaign', sourceId: 'creator42' }), 'link_conflict');
  throwsCode(() => service.createLink({ id: 'referral-b', type: 'referral', sourceId: 'another' }), 'link_conflict');
});

test('inputs reject missing halves, unknown links, arrays and dangerous ids', () => {
  const { service } = setup();
  for (const input of [[], null, { linkId: 'campaign-a' }, { clickId: 'click' }]) {
    throwsCode(() => service.openApp('app-1', input), 'invalid_input');
  }
  throwsCode(() => service.openApp('app-1', { clickId: 'click', linkId: 'missing' }), 'link_not_found');
  for (const id of ['', '/etc/passwd', 'x'.repeat(121), {}, 123]) {
    throwsCode(() => service.openApp(id), 'invalid_input');
  }
  throwsCode(() => service.createLink({ id: 'link', sourceId: 'source', type: 'unknown' }), 'invalid_input');
});

test('community links participate in the same explicit rule', () => {
  const { service } = setup();
  service.createLink({ id: 'community', type: 'community', sourceId: 'club' });
  service.openApp('app-1', { linkId: 'community', clickId: 'community-click' });
  assert.equal(register(service).origin.type, 'community');
});

test('returned objects cannot mutate stored history or immutable origin', () => {
  const { service } = setup();
  const result = open(service);
  result.installation.firstOpenedAt = 'bad';
  result.touch.linkId = 'referral-b';
  const signup = register(service);
  signup.origin.type = 'organic';
  signup.touches[0].reason = 'fake';
  const current = service.auditSignup('signup-1');
  assert.equal(current.origin.type, 'campaign');
  assert.equal(current.touches[0].reason, 'winner');
});

test('failed persistence does not partially commit a mutation', () => {
  let fail = false;
  const store = new MemoryStore();
  const save = store.save.bind(store);
  store.save = state => { if (fail) throw new Error('disk-full'); save(state); };
  const { service } = setup({ store });
  open(service);
  fail = true;
  assert.throws(() => register(service), /disk-full/);
  assert.equal(service.getInstallation('app-1').signup, null);
  fail = false;
  assert.equal(register(service).origin.type, 'campaign');
});

test('configuration is bounded and old installations retain their original window', () => {
  for (const windowMs of [-1, 0, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new AttributionService({ windowMs }), /windowMs/);
  }
  const store = new MemoryStore();
  const { service } = setup({ store, windowMs: 1000 });
  open(service);
  const resumed = new AttributionService({ store, clock: () => new Date(FIRST + 1001), windowMs: 999999 });
  assert.equal(resumed.signup('app-1', { signupId: 'signup-1' }).origin.reason, 'attribution_window_expired');
});

test('date overflow is rejected at first open', () => {
  const service = new AttributionService({ clock: () => new Date(8_640_000_000_000_000) });
  throwsCode(() => service.openApp('app-1'), 'invalid_clock');
});
