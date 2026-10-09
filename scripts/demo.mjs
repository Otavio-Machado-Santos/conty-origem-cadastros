import { AttributionService } from '../src/attribution.js';
import { createApp } from '../src/http.js';

let now = new Date('2026-06-01T12:00:00.000Z');
const service = new AttributionService({ clock: () => new Date(now) });
const server = createApp({ service });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, { method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  console.log(`${method} ${path} → ${response.status}\n${JSON.stringify(result, null, 2)}`);
  if (!response.ok) throw new Error(`Unexpected HTTP ${response.status}`);
  return result;
}
try {
  await request('POST', '/links', { id: 'campanha-verao', type: 'campaign', sourceId: 'verao2026' });
  await request('POST', '/links', { id: 'indicacao-criador42', type: 'referral', sourceId: 'criador42' });
  await request('POST', '/installations/app-1/open', { clickId: 'click-campanha', linkId: 'campanha-verao' });
  now = new Date('2026-06-02T12:00:00.000Z');
  await request('POST', '/installations/app-1/touches', { clickId: 'click-indicacao', linkId: 'indicacao-criador42' });
  await request('POST', '/installations/app-1/touches', { clickId: 'click-indicacao', linkId: 'indicacao-criador42' });
  now = new Date('2026-06-03T12:00:00.000Z');
  await request('POST', '/installations/app-1/signup', { signupId: 'creator-1' });
  now = new Date('2026-06-03T12:00:00.001Z');
  await request('POST', '/installations/app-1/touches', { clickId: 'click-tardio', linkId: 'campanha-verao' });
  const audit = await request('GET', '/signups/creator-1');
  if (audit.origin.type !== 'referral' || audit.touches.length !== 3
    || audit.touches.filter(touch => touch.won).length !== 1
    || audit.touches.at(-1).reason !== 'after_signup') throw new Error('Audit did not match the demonstrated flow');
  console.log('PASSOU: API HTTP real, deduplicação e origem imutável verificadas.');
} finally { await new Promise(resolve => server.close(resolve)); }
