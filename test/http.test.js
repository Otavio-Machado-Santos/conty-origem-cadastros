import test from 'node:test';
import assert from 'node:assert/strict';
import { request as nativeRequest } from 'node:http';
import { AttributionService } from '../src/attribution.js';
import { createApp } from '../src/http.js';

async function setup(t) {
  let now = Date.parse('2026-06-01T12:00:00.000Z');
  const server = createApp({ service: new AttributionService({ clock: () => new Date(now) }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(`${base}${path}`, { method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, result: await response.json() };
  }
  return { base, request, setTime: value => { now = value; } };
}

test('real HTTP flow creates links, opens app, deduplicates click, signs up and audits', async t => {
  const { request, setTime } = await setup(t);
  assert.equal((await request('POST', '/links', { id: 'campaign', type: 'campaign', sourceId: 'summer' })).status, 201);
  assert.equal((await request('POST', '/links', { id: 'referral', type: 'referral', sourceId: 'creator42' })).status, 201);
  const opening = await request('POST', '/installations/app/open', { linkId: 'campaign', clickId: 'first' });
  assert.equal(opening.status, 200);
  setTime(Date.parse('2026-06-02T12:00:00.000Z'));
  await request('POST', '/installations/app/touches', { linkId: 'referral', clickId: 'second' });
  const replay = await request('POST', '/installations/app/touches', { linkId: 'referral', clickId: 'second' });
  assert.equal(replay.result.duplicate, true);
  const signup = await request('POST', '/installations/app/signup', { signupId: 'signup' });
  assert.equal(signup.status, 201);
  assert.equal(signup.result.origin.type, 'referral');
  await request('POST', '/installations/app/touches', { linkId: 'campaign', clickId: 'after' });
  const audit = await request('GET', '/signups/signup');
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.result.origin, signup.result.origin);
  assert.equal(audit.result.touches.length, 3);
  assert.equal(audit.result.touches.find(touch => touch.clickId === 'after').reason, 'after_signup');
  const installation = await request('GET', '/installations/app');
  assert.equal(installation.result.firstOpenedAt, '2026-06-01T12:00:00.000Z');
});

test('HTTP organic signup has a persisted reason and after-signup link cannot change it', async t => {
  const { request } = await setup(t);
  await request('POST', '/installations/app/open', {});
  const signup = await request('POST', '/installations/app/signup', { signupId: 'organic' });
  assert.deepEqual(signup.result.origin, { type: 'organic', reason: 'no_touch' });
  assert.deepEqual((await request('GET', '/signups/organic')).result.origin, signup.result.origin);
});

test('HTTP rejects forged dates, invalid JSON, wrong media type and missing first open', async t => {
  const { base, request } = await setup(t);
  const forged = await request('POST', '/installations/app/open', { firstOpenedAt: '2020-01-01' });
  assert.equal(forged.status, 400);
  assert.equal(forged.result.error.code, 'unknown_field');
  const malformed = await fetch(`${base}/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_json');
  const type = await fetch(`${base}/links`, { method: 'POST', body: '{}' });
  assert.equal(type.status, 415);
  assert.equal((await request('POST', '/installations/app/signup', { signupId: 'signup' })).status, 404);
});

test('HTTP body size limit, path validation and unknown route have explicit errors', async t => {
  const { base, request } = await setup(t);
  const large = await fetch(`${base}/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'a'.repeat(17000) }) });
  assert.equal(large.status, 413);
  assert.equal((await request('GET', '/signups/%ZZ')).status, 400);
  assert.equal((await request('GET', '/unknown')).result.error.code, 'route_not_found');
});

test('HTTP returns explicit conflict for click-id reuse on a different source', async t => {
  const { request } = await setup(t);
  await request('POST', '/links', { id: 'campaign', type: 'campaign', sourceId: 'summer' });
  await request('POST', '/links', { id: 'referral', type: 'referral', sourceId: 'creator42' });
  await request('POST', '/installations/app/open', { linkId: 'campaign', clickId: 'first' });
  const conflict = await request('POST', '/installations/app/touches', { linkId: 'referral', clickId: 'first' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.result.error.code, 'click_conflict');
});

test('chunked oversized bodies get an HTTP 413 response without a socket reset', async t => {
  const { base } = await setup(t);
  const result = await new Promise((resolve, reject) => {
    const request = nativeRequest(`${base}/links`, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, result: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.write('{"payload":"');
    request.write('a'.repeat(17000));
    request.end('"}');
  });
  assert.equal(result.status, 413);
  assert.equal(result.result.error.code, 'body_too_large');
});

test('browser demo is served from the same origin as the actual API', async t => {
  const { base } = await setup(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /Executar fluxo real da API/);
});
