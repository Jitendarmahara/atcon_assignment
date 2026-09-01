import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env.js";

// A relative STORAGE_DIR ("./storage/resumes", the .env default) can't be
// resolved against process.cwd() here: the API (server/) and every worker
// (workers/) are separate packages with separate cwds when their dev/start
// scripts run, so each would resolve a *different* physical directory and
// the worker that parses a resume would never find the file the API just
// wrote - caught exactly this running the two as genuinely separate
// processes for the first time. Anchoring to this file's own compiled
// location instead (packages/core/dist/lib/ -> repo root, 4 levels up)
// resolves identically no matter which package's process is running it. An
// absolute STORAGE_DIR is left untouched.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function resolveStorageDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(REPO_ROOT, dir);
}

// Local-disk implementation of a storage boundary. Swapping to S3/GCS later
// means writing one file that implements this interface - nothing else in
// the codebase (upload handler, resume parser, download endpoint) touches
// the filesystem directly.
export interface StorageAdapter {
  save(buffer: Buffer, originalName: string): Promise<{ storageKey: string; contentHash: string }>;
  read(storageKey: string): Promise<Buffer>;
}

class LocalDiskStorage implements StorageAdapter {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(buffer: Buffer, originalName: string) {
    await this.ensureDir();
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const ext = path.extname(originalName);
    const storageKey = `${randomUUID()}${ext}`;
    await fs.writeFile(path.join(this.dir, storageKey), buffer);
    return { storageKey, contentHash };
  }

  async read(storageKey: string) {
    return fs.readFile(path.join(this.dir, storageKey));
  }
}

export const storage: StorageAdapter = new LocalDiskStorage(resolveStorageDir(env.STORAGE_DIR));
