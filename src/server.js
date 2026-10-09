import { resolve } from 'node:path';
import { AttributionService, DEFAULT_WINDOW_MS } from './attribution.js';
import { FileStore } from './storage.js';
import { createApp } from './http.js';

const port = Number(process.env.PORT ?? 3006);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const service = new AttributionService({
  store: new FileStore(resolve(process.env.ATTRIBUTION_STORE ?? 'data/attribution.json')),
  windowMs: Number(process.env.ATTRIBUTION_WINDOW_MS ?? DEFAULT_WINDOW_MS),
});
const server = createApp({ service });
server.listen(port, '127.0.0.1', () => console.log(`Origem do cadastro: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
