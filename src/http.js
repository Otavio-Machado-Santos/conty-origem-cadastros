import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { AttributionError, AttributionService } from './attribution.js';

const MAX_BODY_BYTES = 16 * 1024;
const demo = readFileSync(new URL('../public/index.html', import.meta.url));

async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new AttributionError(415, 'unsupported_media_type', 'Use Content-Type: application/json');
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw new AttributionError(413, 'body_too_large', 'Maximum request body is 16 KiB');
  }
  const bytes = await new Promise((resolve, reject) => {
    let chunks = [];
    let length = 0;
    let oversized = false;
    request.on('data', chunk => {
      if (oversized) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        oversized = true;
        chunks = [];
        reject(new AttributionError(413, 'body_too_large', 'Maximum request body is 16 KiB'));
      } else chunks.push(chunk);
    });
    request.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(new AttributionError(400, 'aborted_request', 'Request body was interrupted')));
  });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new AttributionError(400, 'invalid_json', 'Body must be valid JSON'); }
}

function send(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(data, null, 2)}\n`);
}

export function createApp({ service = new AttributionService() } = {}) {
  return createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let path;
      try { path = url.pathname.split('/').map(decodeURIComponent); }
      catch { throw new AttributionError(400, 'invalid_path', 'Malformed URL encoding'); }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
        response.end(demo);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/links') {
        send(response, 201, service.createLink(await jsonBody(request)));
        return;
      }
      if (path.length === 4 && path[1] === 'installations' && request.method === 'POST') {
        const input = await jsonBody(request);
        if (path[3] === 'open') { send(response, 200, service.openApp(path[2], input)); return; }
        if (path[3] === 'touches') { send(response, 200, service.recordTouch(path[2], input)); return; }
        if (path[3] === 'signup') { send(response, 201, service.signup(path[2], input)); return; }
      }
      if (path.length === 3 && path[1] === 'installations' && request.method === 'GET') {
        send(response, 200, service.getInstallation(path[2]));
        return;
      }
      if (path.length === 3 && path[1] === 'signups' && request.method === 'GET') {
        send(response, 200, service.auditSignup(path[2]));
        return;
      }
      send(response, 404, { error: { code: 'route_not_found', message: 'Unknown route' } });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof AttributionError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        send(response, 500, { error: { code: 'internal_error', message: 'No change was committed' } });
      }
    }
  });
}
