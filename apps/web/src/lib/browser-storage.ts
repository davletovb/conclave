import type { StorageBackend } from "../../../server/src/state/store";

/**
 * Conclave's own persistence backend. IndexedDB records replace app-server files.
 *
 * A file is a whole value in `records` (written by `writeFile`) and/or a run of appended chunks in `chunks`,
 * numbered by a small counter kept in `records` under `path + APPENDED`. Appending stores one small chunk and
 * bumps the counter, so an append costs the same however long the log already is; reading joins the value and
 * the chunks. Run event logs are appended to once per event, so rewriting the whole log each time would make
 * a long run cost quadratic time and bytes.
 */
const APPENDED = "\u0002";
const RECORDS = "records";
const CHUNKS = "chunks";

export class BrowserStorage implements StorageBackend {
  private db: Promise<IDBDatabase>;
  constructor(name = "conclave.state.v1") {
    this.db = new Promise((resolve, reject) => {
      // Version 2 adds the chunk store. An existing version 1 database keeps every record it has.
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        for (const store of [RECORDS, CHUNKS]) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  join(...parts: string[]) { return parts.join("/").replace(/\/{2,}/g, "/"); }
  async mkdir() { /* records use key prefixes */ }
  async chmod() { /* browser-origin isolation owns access */ }

  private async transaction<T>(mode: IDBTransactionMode, operation: (stores: { records: IDBObjectStore; chunks: IDBObjectStore }, done: (value: T) => void) => void): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([RECORDS, CHUNKS], mode); let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Conclave storage transaction aborted"));
      try { operation({ records: transaction.objectStore(RECORDS), chunks: transaction.objectStore(CHUNKS) }, value => { result = value; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }

  private chunkRange(path: string) { return IDBKeyRange.bound([path, 0], [path, Number.MAX_SAFE_INTEGER]); }

  async readFile(path: string): Promise<string> {
    const value = await this.transaction<string | undefined>("readonly", ({ records, chunks }, done) => {
      const base = records.get(path);
      const marker = records.get(path + APPENDED);
      base.onsuccess = () => marker.onsuccess = () => {
        if (base.result === undefined && marker.result === undefined) { done(undefined); return; }
        const parts = chunks.getAll(this.chunkRange(path));
        parts.onsuccess = () => done(((base.result as string | undefined) ?? "") + (parts.result as string[]).join(""));
      };
    });
    if (value === undefined) throw Object.assign(new Error("Conclave record not found"), { code: "ENOENT" });
    return value;
  }

  /** Replaces the file: the new value, and no chunks left over from earlier appends. */
  async writeFile(path: string, text: string) {
    return this.transaction<void>("readwrite", ({ records, chunks }, done) => {
      records.put(text, path); records.delete(path + APPENDED); chunks.delete(this.chunkRange(path)); done();
    });
  }

  async appendFile(path: string, text: string) {
    return this.transaction<void>("readwrite", ({ records, chunks }, done) => {
      const marker = records.get(path + APPENDED);
      marker.onsuccess = () => {
        const next = (marker.result as number | undefined) ?? 0;
        chunks.put(text, [path, next]); records.put(next + 1, path + APPENDED); done();
      };
    });
  }

  async readdir(path: string) {
    return this.transaction<Array<{ name: string; isFile(): boolean }>>("readonly", ({ records }, done) => {
      const prefix = `${path}/`;
      const request = records.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿"));
      request.onsuccess = () => {
        const names = new Set<string>();
        for (const key of request.result) {
          if (typeof key !== "string") continue;
          const name = (key.endsWith(APPENDED) ? key.slice(0, -APPENDED.length) : key).slice(prefix.length);
          if (name && !name.includes("/")) names.add(name);
        }
        done([...names].map(name => ({ name, isFile: () => true })));
      };
    });
  }

  async rename(from: string, to: string) {
    return this.transaction<void>("readwrite", ({ records, chunks }, done) => {
      const base = records.get(from);
      const marker = records.get(from + APPENDED);
      const parts = chunks.getAll(this.chunkRange(from));
      let ready = 0;
      const move = () => {
        if (++ready < 3) return;
        if (base.result === undefined && marker.result === undefined) { records.transaction.abort(); return; }
        records.delete(to); records.delete(to + APPENDED); chunks.delete(this.chunkRange(to));
        if (base.result !== undefined) records.put(base.result, to);
        if (marker.result !== undefined) {
          records.put(marker.result, to + APPENDED);
          (parts.result as string[]).forEach((chunk, index) => chunks.put(chunk, [to, index]));
        }
        records.delete(from); records.delete(from + APPENDED); chunks.delete(this.chunkRange(from));
        done();
      };
      base.onsuccess = move; marker.onsuccess = move; parts.onsuccess = move;
    });
  }

  async rm(path: string) {
    return this.transaction<void>("readwrite", ({ records, chunks }, done) => {
      records.delete(path); records.delete(path + APPENDED); chunks.delete(this.chunkRange(path)); done();
    });
  }

  async truncate(path: string, length: number) { await this.writeFile(path, (await this.readFile(path)).slice(0, length)); }
}
