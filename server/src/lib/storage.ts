import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env.js";

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

export const storage: StorageAdapter = new LocalDiskStorage(env.STORAGE_DIR);
