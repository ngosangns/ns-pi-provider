import { describe, it, expect, beforeEach } from "vitest";
import { CatalogCache } from "../src/shared/catalog-cache.js";
import { parseGrokModelsOutput, fallbackModels, toProviderModels } from "../src/grok/models.js";
import { refreshGrokModels } from "../src/grok/register.js";
import { ensureCacheCost } from "../src/shared/types.js";

describe("grok models + cache", () => {
  let cache: CatalogCache;
  const memFs = new Map<string, string>();
  let now = 0;

  beforeEach(() => {
    now = 1000;
    memFs.clear();
    cache = new CatalogCache({
      cacheDir: "/tmp/ns-pi-grok-cache",
      ttlMs: 10_000,
      now: () => now,
      fs: {
        existsSync: (p) => memFs.has(String(p)),
        readFileSync: (p) => {
          const v = memFs.get(String(p));
          if (!v) throw new Error("ENOENT");
          return v;
        },
        writeFileSync: (p, d) => {
          memFs.set(String(p), String(d));
        },
        mkdirSync: () => undefined,
        renameSync: (a, b) => {
          memFs.set(String(b), memFs.get(String(a))!);
          memFs.delete(String(a));
        },
      },
    });
  });

  it("parses CLI models output", () => {
    const parsed = parseGrokModelsOutput(`
Available models:
  * grok-4.5 (default)
  * grok-4.6
Default model: grok-4.5
`);
    expect(parsed.map((m) => m.id)).toEqual(expect.arrayContaining(["grok-4.5", "grok-4.6"]));
  });

  it("toProviderModels includes cache cost fields", () => {
    const models = toProviderModels(fallbackModels());
    for (const m of models) {
      const cost = ensureCacheCost(m.cost);
      expect(cost).toHaveProperty("cacheRead");
      expect(cost).toHaveProperty("cacheWrite");
    }
  });

  it("refreshGrokModels caches and hits TTL", () => {
    const first = refreshGrokModels({ force: true, binary: undefined, cache });
    expect(first.fromCache).toBe(false);
    expect(first.models.length).toBeGreaterThan(0);
    // costs on provider models
    expect(first.models[0].cost).toMatchObject({
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
    });

    const second = refreshGrokModels({ binary: undefined, cache });
    expect(second.fromCache).toBe(true);
    expect(second.source).toBe("cache");
  });
});
