import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_FORMAT_VERSION = 1;

export interface PdfCacheOptions {
  formatVersion?: number;
  ttlMs?: number;
  now?: () => number;
}

export class PdfCache {
  private db: Database.Database;
  private formatVersion: number;
  private ttlMs: number;
  private now: () => number;

  constructor(cacheDir: string, options: PdfCacheOptions = {}) {
    this.formatVersion = options.formatVersion ?? DEFAULT_FORMAT_VERSION;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());

    mkdirSync(cacheDir, { recursive: true });
    this.db = new Database(join(cacheDir, "pdf-cache.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pdf_cache (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        content_hash TEXT NOT NULL,
        format_version INTEGER NOT NULL,
        content TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )
    `);
  }

  /** Fast path: returns content if size+mtime match and not expired. No hash needed. */
  getFast(path: string, size: number, mtime: number): string | null {
    const row = this.db
      .prepare("SELECT * FROM pdf_cache WHERE path = ?")
      .get(path) as
      | {
          size: number;
          mtime: number;
          format_version: number;
          content: string;
          cached_at: number;
        }
      | undefined;

    if (!row) return null;
    if (row.format_version !== this.formatVersion) return null;
    if (this.now() - row.cached_at > this.ttlMs) {
      this.db.prepare("DELETE FROM pdf_cache WHERE path = ?").run(path);
      return null;
    }
    if (row.size === size && row.mtime === mtime) {
      return row.content;
    }
    return null;
  }

  /** Slow path: returns content if content hash matches. */
  getByHash(path: string, contentHash: string): string | null {
    const row = this.db
      .prepare("SELECT * FROM pdf_cache WHERE path = ?")
      .get(path) as
      | {
          content_hash: string;
          format_version: number;
          content: string;
          cached_at: number;
        }
      | undefined;

    if (!row) return null;
    if (row.format_version !== this.formatVersion) return null;
    if (this.now() - row.cached_at > this.ttlMs) {
      this.db.prepare("DELETE FROM pdf_cache WHERE path = ?").run(path);
      return null;
    }
    if (row.content_hash === contentHash) {
      return row.content;
    }
    return null;
  }

  /** Update the stored mtime for a path (used after hash-based cache hit with changed mtime). */
  updateMtime(path: string, mtime: number): void {
    this.db
      .prepare("UPDATE pdf_cache SET mtime = ? WHERE path = ?")
      .run(mtime, path);
  }

  set(
    path: string,
    size: number,
    mtime: number,
    contentHash: string,
    content: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pdf_cache
         (path, size, mtime, content_hash, format_version, content, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        path,
        size,
        mtime,
        contentHash,
        this.formatVersion,
        content,
        this.now(),
      );
  }

  close(): void {
    this.db.close();
  }
}
