import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, truncate, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StateStore, type StorageBackend } from "./store.js";
export type { ListOptions, CreatedRun } from "./store.js";

const storage: StorageBackend = {join,appendFile,chmod,readFile,readdir,rename,rm,truncate,writeFile,mkdir} as StorageBackend;
export class FileStateStore extends StateStore {
  constructor(dataDir = process.env.CONCLAVE_DATA_DIR || join(homedir(), ".conclave")) { super(dataDir,storage); }
}
