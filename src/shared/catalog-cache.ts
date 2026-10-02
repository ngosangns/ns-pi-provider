/**
 * Disk-backed model catalog cache with TTL + optional ETag/version.
 * Used by kiro / devin / grok discovery so a second identical call within TTL
 * does not re-hit the network.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CatalogSnapshot } from "./types.js";

export interface CatalogCacheOptions {
  /** Cache directory root. Defaults to ~/.pi/agent/cache/ns-pi-provider */
  cacheDir?: string;
  /** Default TTL in milliseconds (default 15 minutes). */
  ttlMs?: number;
  /** Clock for tests. */
  now?: () => number;
  /** Filesystem overrides for tests. */
  fs?: {
    readFileSync?: (path: string, encoding?: string) => string;
    writeFileSync?: (path: string, data: string, encoding?: string) => void;
    mkdirSync?: (path: string, opts?: { recursive?: boolean }) => void;
    renameSync?: (from: string, to: string) => void;
    existsSync?: (path: string) => boolean;
  };
}

export interface CatalogCacheHit<T> {
  hit: true;
  snapshot: CatalogSnapshot<T>;
  reason: "ttl" | "etag";
}

export interface CatalogCacheMiss {
  hit: false;
  snapshot?: undefined;
  reason: "missing" | "expired" | "version-mismatch" | "corrupt";
  etag?: string;
}

export type CatalogCacheLookup<T> = CatalogCacheHit<T> | CatalogCacheMiss;

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function defaultCacheDir(): string {
  return join(homedir(), ".pi", "agent", "cache", "ns-pi-provider");
}

export class CatalogCache {
  readonly cacheDir: string;
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fs: {
    readFileSync: (path: string, encoding?: string) => string;
    writeFileSync: (path: string, data: string, encoding?: string) => void;
    mkdirSync: (path: string, opts?: { recursive?: boolean }) => void;
    renameSync: (from: string, to: string) => void;
    existsSync: (path: string) => boolean;
  };
  /** In-memory layer so hermetic tests and same-process hits avoid disk races. */
  private memory = new Map<string, CatalogSnapshot>();

  constructor(options: CatalogCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.fs = {
      readFileSync: (options.fs?.readFileSync ?? (readFileSync as unknown as (path: string, encoding?: string) => string)),
      writeFileSync: (options.fs?.writeFileSync ?? ((path, data) => writeFileSync(path, data, "utf8"))),
      mkdirSync: (options.fs?.mkdirSync ?? ((path, opts) => { mkdirSync(path, opts); })),
      renameSync: (options.fs?.renameSync ?? renameSync),
      existsSync: (options.fs?.existsSync ?? existsSync),
    };
  }

  pathFor(providerId: string): string {
    return join(this.cacheDir, `${providerId}.models.json`);
  }

  lookup<T>(providerId: string, expectedVersion?: string): CatalogCacheLookup<T> {
    const mem = this.memory.get(providerId) as CatalogSnapshot<T> | undefined;
    if (mem) {
      if (expectedVersion && mem.version !== expectedVersion) {
        return { hit: false, reason: "version-mismatch", etag: mem.etag };
      }
      if (this.now() - mem.fetchedAt <= this.ttlMs) {
        return { hit: true, snapshot: mem, reason: "ttl" };
      }
      return { hit: false, reason: "expired", etag: mem.etag };
    }

    const path = this.pathFor(providerId);
    if (!this.fs.existsSync(path)) {
      return { hit: false, reason: "missing" };
    }
    try {
      const raw = this.fs.readFileSync(path, "utf8");
      const snapshot = JSON.parse(raw) as CatalogSnapshot<T>;
      if (!snapshot || !Array.isArray(snapshot.models) || typeof snapshot.fetchedAt !== "number") {
        return { hit: false, reason: "corrupt" };
      }
      this.memory.set(providerId, snapshot as CatalogSnapshot);
      if (expectedVersion && snapshot.version !== expectedVersion) {
        return { hit: false, reason: "version-mismatch", etag: snapshot.etag };
      }
      if (this.now() - snapshot.fetchedAt <= this.ttlMs) {
        return { hit: true, snapshot, reason: "ttl" };
      }
      return { hit: false, reason: "expired", etag: snapshot.etag };
    } catch {
      return { hit: false, reason: "corrupt" };
    }
  }

  store<T>(
    providerId: string,
    models: T[],
    options: { version?: string; etag?: string; fetchedAt?: number } = {},
  ): CatalogSnapshot<T> {
    const snapshot: CatalogSnapshot<T> = {
      version: options.version ?? "1",
      etag: options.etag,
      fetchedAt: options.fetchedAt ?? this.now(),
      models,
    };
    this.memory.set(providerId, snapshot as CatalogSnapshot);
    try {
      this.fs.mkdirSync(this.cacheDir, { recursive: true });
      const path = this.pathFor(providerId);
      const tmp = `${path}.${process.pid}.tmp`;
      this.fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      this.fs.renameSync(tmp, path);
    } catch {
      // Disk persistence is best-effort; in-memory still serves TTL hits.
    }
    return snapshot;
  }

  clear(providerId?: string): void {
    if (providerId) {
      this.memory.delete(providerId);
      return;
    }
    this.memory.clear();
  }

  /**
   * Fetch-through helper: returns cached models on TTL hit; otherwise calls
   * `fetcher`, stores the result, and returns it. Pass `force: true` to bypass TTL.
   */
  async getOrFetch<T>(
    providerId: string,
    fetcher: (prev?: CatalogSnapshot<T>) => Promise<{ models: T[]; version?: string; etag?: string }>,
    options: { force?: boolean; version?: string } = {},
  ): Promise<{ models: T[]; fromCache: boolean; etag?: string }> {
    if (!options.force) {
      const lookup = this.lookup<T>(providerId, options.version);
      if (lookup.hit) {
        return { models: lookup.snapshot.models, fromCache: true, etag: lookup.snapshot.etag };
      }
      const prev = lookup.etag
        ? ({
            version: options.version ?? "1",
            etag: lookup.etag,
            fetchedAt: 0,
            models: [],
          } satisfies CatalogSnapshot<T>)
        : undefined;
      const fetched = await fetcher(prev);
      // If upstream returned 304-equivalent empty with same etag, keep previous disk models if any
      if (fetched.models.length === 0 && lookup.etag && fetched.etag === lookup.etag) {
        const expired = this.memory.get(providerId) as CatalogSnapshot<T> | undefined;
        if (expired?.models?.length) {
          const refreshed = this.store(providerId, expired.models, {
            version: expired.version,
            etag: fetched.etag ?? expired.etag,
          });
          return { models: refreshed.models, fromCache: true, etag: refreshed.etag };
        }
      }
      const stored = this.store(providerId, fetched.models, {
        version: fetched.version ?? options.version ?? "1",
        etag: fetched.etag,
      });
      return { models: stored.models, fromCache: false, etag: stored.etag };
    }

    const fetched = await fetcher();
    const stored = this.store(providerId, fetched.models, {
      version: fetched.version ?? options.version ?? "1",
      etag: fetched.etag,
    });
    return { models: stored.models, fromCache: false, etag: stored.etag };
  }
}

/** Process-wide default cache (providers share one instance). */
let defaultCache: CatalogCache | undefined;

export function getDefaultCatalogCache(options?: CatalogCacheOptions): CatalogCache {
  if (options) {
    defaultCache = new CatalogCache(options);
    return defaultCache;
  }
  defaultCache ??= new CatalogCache();
  return defaultCache;
}

export function resetDefaultCatalogCache(): void {
  defaultCache?.clear();
  defaultCache = undefined;
}
