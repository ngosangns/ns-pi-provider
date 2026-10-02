import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CatalogCache } from "../src/shared/catalog-cache.js";
import { refreshKiroModels, resolveKiroDiscoveryToken, kiroListBaseUrl } from "../src/kiro/register.js";
import { discoverKiroModels } from "../src/kiro/discover.js";

describe("kiro discovery + cache", () => {
  let cache: CatalogCache;
  const memFs = new Map<string, string>();
  let now = 0;

  beforeEach(() => {
    now = 1000;
    memFs.clear();
    cache = new CatalogCache({
      cacheDir: "/tmp/ns-pi-kiro-cache",
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

  it("builds list base URL for region", () => {
    expect(kiroListBaseUrl("eu-west-1")).toBe("https://q.eu-west-1.amazonaws.com/");
  });

  it("resolveKiroDiscoveryToken reads env without throwing", () => {
    const hit = resolveKiroDiscoveryToken({ KIRO_API_KEY: "test-key-not-real" }, { readFiles: false });
    expect(hit?.source).toBe("env");
    expect(hit?.token).toBe("test-key-not-real");
    // Do not scan real SSO files in unit tests (avoids secret leakage in diffs).
    expect(resolveKiroDiscoveryToken({}, { readFiles: false })).toBeUndefined();
    expect(resolveKiroDiscoveryToken({}, { paths: [] })).toBeUndefined();
  });

  it("second refresh within TTL does not re-hit network (mocked discover)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              modelId: "claude-sonnet-4.6",
              modelName: "Claude Sonnet 4.6",
              supportedInputTypes: ["TEXT", "IMAGE"],
              tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 8192 },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // Patch global fetch used by discoverKiroModels
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const first = await refreshKiroModels({
        force: true,
        token: "tok",
        baseUrl: "https://q.us-east-1.amazonaws.com/",
        cache,
      });
      expect(first.fromCache).toBe(false);
      expect(first.models.length).toBeGreaterThan(0);
      expect(first.models[0].cost).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
      expect(fetchImpl).toHaveBeenCalled();

      const callsAfterFirst = fetchImpl.mock.calls.length;
      const second = await refreshKiroModels({
        token: "tok",
        baseUrl: "https://q.us-east-1.amazonaws.com/",
        cache,
      });
      expect(second.fromCache).toBe(true);
      expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns fallback when no token and empty cache", async () => {
    const fallback = [
      {
        id: "auto",
        name: "Auto",
        api: "kiro",
        provider: "kiro",
        input: ["text"] as Array<"text" | "image">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    ];
    const result = await refreshKiroModels({
      token: undefined,
      cache,
      fallback,
    });
    // force token undefined by not setting env — pass empty token explicitly via omitting
    expect(result.models).toEqual(fallback);
  });

  it("discover omits tokentype for OAuth bearers and sets it for ksk_ keys", async () => {
    const calls: Array<{ headers: Headers }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ headers: new Headers(init?.headers) });
      return new Response(
        JSON.stringify({
          models: [{ modelId: "claude-sonnet-4.6", modelName: "Claude Sonnet 4.6", supportedInputTypes: ["TEXT"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await discoverKiroModels("oauth-bearer-not-a-key", "https://q.us-east-1.amazonaws.com/");
      expect(calls[0].headers.get("tokentype")).toBeNull();
      await discoverKiroModels("ksk_test_key_not_real", "https://q.us-east-1.amazonaws.com/");
      expect(calls[1].headers.get("tokentype")).toBe("API_KEY");
      expect(calls[1].headers.get("X-Amz-Target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("resolveKiroDiscoveryToken prefers freshest non-expired file token", () => {
    const dir = "/tmp/ns-pi-kiro-token-pick";
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "stale.json");
    const fresh = join(dir, "fresh.json");
    writeFileSync(
      stale,
      JSON.stringify({
        accessToken: "stale-token",
        region: "us-west-2",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    writeFileSync(
      fresh,
      JSON.stringify({
        accessToken: "fresh-token",
        region: "eu-west-1",
        authMethod: "IdC",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const hit = resolveKiroDiscoveryToken({}, { paths: [stale, fresh] });
    expect(hit?.token).toBe("fresh-token");
    expect(hit?.region).toBe("eu-west-1");
    expect(hit?.authMethod).toBe("IdC");
    rmSync(dir, { recursive: true, force: true });
  });
});
