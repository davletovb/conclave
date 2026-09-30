import type { StorageBackend } from "../../../../server/src/state/store";

/** Conclave's own persistence backend. IndexedDB records replace app-server files. */
export class BrowserStorage implements StorageBackend {
  private db: Promise<IDBDatabase>;
  constructor(name = "conclave.state.v1") {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  join(...parts: string[]) { return parts.join("/").replace(/\/{2,}/g, "/"); }
  async mkdir() { /* records use key prefixes */ }
  async chmod() { /* browser-origin isolation owns access */ }

  private async transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("records", mode); let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Conclave storage transaction aborted"));
      try { operation(transaction.objectStore("records"), value => { result = value; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }
  async readFile(path: string): Promise<string> {
    const value = await this.transaction<string | undefined>("readonly", (store, done) => {
      const request = store.get(path); request.onsuccess = () => done(request.result as string | undefined);
    });
    if (value === undefined) throw Object.assign(new Error("Conclave record not found"), { code: "ENOENT" });
    return value;
  }
  async writeFile(path: string, text: string) { return this.transaction<void>("readwrite", (store, done) => { store.put(text, path); done(); }); }
  async appendFile(path: string, text: string) {
    return this.transaction<void>("readwrite", (store, done) => {
      const request = store.get(path); request.onsuccess = () => { store.put((request.result ?? "") + text, path); done(); };
    });
  }
  async readdir(path: string) {
    return this.transaction<Array<{ name: string; isFile(): boolean }>>("readonly", (store, done) => {
      const request = store.getAllKeys(); request.onsuccess = () => {
        const prefix = `${path}/`;
        done(request.result.filter((key): key is string => typeof key === "string" && key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(key => ({ name: key.slice(prefix.length), isFile: () => true })));
      };
    });
  }
  async rename(from: string, to: string) {
    return this.transaction<void>("readwrite", (store, done) => {
      const request = store.get(from); request.onsuccess = () => {
        if (request.result === undefined) { store.transaction.abort(); return; }
        store.put(request.result, to); store.delete(from); done();
      };
    });
  }
  async rm(path: string) { return this.transaction<void>("readwrite", (store, done) => { store.delete(path); done(); }); }
  async truncate(path: string, length: number) { await this.writeFile(path, (await this.readFile(path)).slice(0, length)); }
}
