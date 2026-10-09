import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionService } from '../src/attribution.js';
import { FileStore } from '../src/storage.js';

test('restart preserves first open, click deduplication, original origin and late audit', t => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-attribution-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'data', 'state.json');
  let now = Date.parse('2026-06-01T00:00:00.000Z');
  const options = { store: new FileStore(path), clock: () => new Date(now) };
  const service = new AttributionService(options);
  service.createLink({ id: 'campaign', type: 'campaign', sourceId: 'summer' });
  service.openApp('app', { linkId: 'campaign', clickId: 'first' });
  service.signup('app', { signupId: 'signup' });
  now += 1000;
  service.recordTouch('app', { linkId: 'campaign', clickId: 'late' });
  const expected = service.auditSignup('signup');
  const resumed = new AttributionService(options);
  assert.deepEqual(resumed.auditSignup('signup'), expected);
  assert.equal(resumed.openApp('app', { linkId: 'campaign', clickId: 'first' }).duplicate, true);
  assert.equal(resumed.getInstallation('app').touches.length, 2);
  assert.equal(resumed.getInstallation('app').firstOpenedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(directory, 'data')), ['state.json']);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 1);
});

test('corrupted or unsupported persisted state fails startup instead of resetting attribution', t => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-attribution-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  writeFileSync(path, '{ invalid');
  assert.throws(() => new AttributionService({ store: new FileStore(path) }), /Cannot read attribution store/);
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, links: [], installations: [] }));
  assert.throws(() => new AttributionService({ store: new FileStore(path) }), /Unsupported or invalid/);
});

test('missing store parents are created only when a valid mutation is committed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-attribution-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'data', 'state.json');
  const service = new AttributionService({ store: new FileStore(path) });
  assert.deepEqual(readdirSync(directory), []);
  assert.throws(() => service.openApp('/invalid'));
  assert.deepEqual(readdirSync(directory), []);
  service.openApp('app');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).installations[0].id, 'app');
});
