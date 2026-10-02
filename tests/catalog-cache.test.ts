import { describe, it, expect, beforeEach } from "vitest";
import { CatalogCache, resetDefaultCatalogCache } from "../src/shared/catalog-cache.js";
import { ensureCacheCost, ZERO_COST } from "../src/shared/types.js";
import type { CatalogModel } from "../src/shared/types.js";

function sampleModels(n = 2): CatalogModel[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `model-${i}`,
    name: `Model ${i}`,
    api: "test",
    provider: "test",
    input: ["text"] as Array<"text" | "image">,
    cost: ensureCacheCost({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.25 }),
    contextWindow: 100_000,
    maxTokens: 8_192,
  }));
}

describe("CatalogCache", () => {
  let now = 1_000_000;
  let cache: CatalogCache;
  const memFs = new Map<string, string>();

  beforeEach(() => {
    now = 1_000_000;
    memFs.clear();
    resetDefaultCatalogCache();
    cache = new CatalogCache({
      cacheDir: "/tmp/ns-pi-provider-test-cache",
      ttlMs: 60_000,
      now: () => now,
      fs: {
        existsSync: (p) => memFs.has(String(p)),
        readFileSync: (p) => {
          const v = memFs.get(String(p));
          if (v === undefined) throw new Error("ENOENT");
          return v;
        },
        writeFileSync: (p, data) => {
          memFs.set(String(p), String(data));
        },
        mkdirSync: () => undefined,
        renameSync: (from, to) => {
          const v = memFs.get(String(from));
          if (v === undefined) throw new Error("ENOENT");
          memFs.set(String(to), v);
          memFs.delete(String(from));
        },
      },
    });
  });

  it("ensures cacheRead/cacheWrite on costs", () => {
    expect(ensureCacheCost(undefined)).toEqual(ZERO_COST);
    expect(ensureCacheCost({ input: 1, output: 2 })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const full = ensureCacheCost({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(full.cacheRead).toBe(3);
    expect(full.cacheWrite).toBe(4);
  });

  it("misses when empty, hits within TTL", async () => {
    const models = sampleModels();
    let fetches = 0;
    const first = await cache.getOrFetch("kiro", async () => {
      fetches += 1;
      return { models, version: "v1", etag: "E1" };
    });
    expect(first.fromCache).toBe(false);
    expect(fetches).toBe(1);
    expect(first.models[0].cost.cacheRead).toBe(0.1);
    expect(first.models[0].cost.cacheWrite).toBe(0.25);

    const second = await cache.getOrFetch("kiro", async () => {
      fetches += 1;
      return { models: sampleModels(9), version: "v1" };
    });
    expect(second.fromCache).toBe(true);
    expect(fetches).toBe(1); // no re-fetch within TTL
    expect(second.models).toHaveLength(2);
  });

  it("re-fetches after TTL expiry", async () => {
    let fetches = 0;
    await cache.getOrFetch("devin", async () => {
      fetches += 1;
      return { models: sampleModels(1), version: "v1" };
    });
    now += 60_001;
    const next = await cache.getOrFetch("devin", async () => {
      fetches += 1;
      return { models: sampleModels(3), version: "v1" };
    });
    expect(fetches).toBe(2);
    expect(next.fromCache).toBe(false);
    expect(next.models).toHaveLength(3);
  });

  it("force bypasses TTL", async () => {
    let fetches = 0;
    await cache.getOrFetch("grok", async () => {
      fetches += 1;
      return { models: sampleModels(1) };
    });
    await cache.getOrFetch(
      "grok",
      async () => {
        fetches += 1;
        return { models: sampleModels(5) };
      },
      { force: true },
    );
    expect(fetches).toBe(2);
  });

  it("lookup reports missing/expired reasons", () => {
    expect(cache.lookup("none").hit).toBe(false);
    if (!cache.lookup("none").hit) {
      expect(cache.lookup("none").reason).toBe("missing");
    }
    cache.store("x", sampleModels(1), { version: "1" });
    expect(cache.lookup("x").hit).toBe(true);
    now += 999_999;
    const expired = cache.lookup("x");
    expect(expired.hit).toBe(false);
    if (!expired.hit) expect(expired.reason).toBe("expired");
  });
});
