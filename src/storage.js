import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function emptyState() {
  return { schemaVersion: 1, links: [], installations: [] };
}

export class MemoryStore {
  #state;

  constructor(initialState = emptyState()) {
    this.#state = structuredClone(initialState);
  }

  load() { return structuredClone(this.#state); }
  save(state) { this.#state = structuredClone(state); }
}

/** Atomic snapshots for a single API process. A failed save never replaces service state. */
export class FileStore {
  constructor(path) { this.path = path; }

  load() {
    try { return JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw new Error(`Cannot read attribution store: ${error.message}`, { cause: error });
    }
  }

  save(state) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }
}
