import { describe, it, expect, vi, beforeEach } from "vitest";
import { CatalogCache } from "../src/shared/catalog-cache.js";
import { refreshDevinModels, resolveDevinToken } from "../src/devin/register.js";
import { decodeDiscoveredDevinModels } from "../src/devin/discovery.js";

describe("devin discovery + cache", () => {
  let cache: CatalogCache;
  const memFs = new Map<string, string>();
  let now = 0;

  beforeEach(() => {
    now = 1000;
    memFs.clear();
    cache = new CatalogCache({
      cacheDir: "/tmp/ns-pi-devin-cache",
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

  it("resolveDevinToken prefers env", () => {
    expect(resolveDevinToken({ DEVIN_API_KEY: "abc" })).toBe("abc");
  });

  it("decodeDiscoveredDevinModels handles empty protobuf gracefully", () => {
    expect(decodeDiscoveredDevinModels(new Uint8Array())).toEqual([]);
  });

  it("cache hit skips second network call", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(), { status: 200 }));
    // First call: discovery returns empty → fallback models stored
    const first = await refreshDevinModels({
      force: true,
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
    });
    expect(first.fromCache).toBe(false);
    expect(first.models.length).toBeGreaterThan(0);
    expect(first.models[0].cost.cacheRead).toBeDefined();
    expect(first.models[0].cost.cacheWrite).toBeDefined();

    const calls = fetchImpl.mock.calls.length;
    const second = await refreshDevinModels({
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
    });
    expect(second.fromCache).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });
});
