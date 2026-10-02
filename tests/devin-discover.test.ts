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

describe("devin CLI credentials.toml auth", () => {
  it("parseDevinCredentialsToml reads windsurf_api_key", async () => {
    const { parseDevinCredentialsToml } = await import("../src/devin/register.js");
    expect(
      parseDevinCredentialsToml(`
api_server_url = "https://server.codeium.com"
windsurf_api_key = "devin-session-token$abc123"
devin_webapp_host = "https://app.devin.ai"
`),
    ).toBe("devin-session-token$abc123");
  });

  it("resolveDevinToken reads credentials.toml without env", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { resolveDevinToken } = await import("../src/devin/register.js");

    const dir = mkdtempSync(join(tmpdir(), "ns-pi-devin-cred-"));
    const credPath = join(dir, "credentials.toml");
    writeFileSync(
      credPath,
      'windsurf_api_key = "toml-only-token"\napi_server_url = "https://server.codeium.com"\n',
      "utf8",
    );
    try {
      expect(resolveDevinToken({}, { paths: [credPath] })).toBe("toml-only-token");
      expect(resolveDevinToken({}, { paths: [credPath], readFiles: false })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveDevinApiKeyConfig prefers env ref then file literal", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { resolveDevinApiKeyConfig } = await import("../src/devin/register.js");

    expect(resolveDevinApiKeyConfig({ DEVIN_API_KEY: "from-env" }, { readFiles: false })).toBe(
      "$DEVIN_API_KEY",
    );

    const dir = mkdtempSync(join(tmpdir(), "ns-pi-devin-apikey-"));
    const credPath = join(dir, "credentials.toml");
    writeFileSync(credPath, 'windsurf_api_key = "file-token"\n', "utf8");
    try {
      expect(resolveDevinApiKeyConfig({}, { paths: [credPath] })).toBe("file-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registerDevinProvider sets apiKey when credentials.toml exists", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { vi } = await import("vitest");

    // Re-import after stubbing paths via env XDG_DATA_HOME
    const dir = mkdtempSync(join(tmpdir(), "ns-pi-devin-xdg-"));
    const credDir = join(dir, "devin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(credDir, "credentials.toml"), 'windsurf_api_key = "xdg-token"\n', "utf8");

    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    // Clear env tokens that would win
    const prevDevin = process.env.DEVIN_API_KEY;
    const prevSess = process.env.DEVIN_SESSION_TOKEN;
    const prevWind = process.env.WINDSURF_API_KEY;
    delete process.env.DEVIN_API_KEY;
    delete process.env.DEVIN_SESSION_TOKEN;
    delete process.env.WINDSURF_API_KEY;

    try {
      // Dynamic import of register after env is set — module already loaded, but
      // resolveDevinApiKeyConfig reads env/paths at call time.
      const { registerDevinProvider } = await import("../src/devin/register.js");
      const providers = new Map<string, { apiKey?: string; models: unknown[]; oauth?: unknown }>();
      const api = {
        registerProvider: vi.fn((id: string, config: { apiKey?: string; models: unknown[]; oauth?: unknown }) => {
          providers.set(id, config);
        }),
        registerCommand: vi.fn(),
        on: vi.fn(),
      };
      registerDevinProvider(api as never);
      const cfg = providers.get("devin");
      expect(cfg).toBeTruthy();
      expect(cfg!.apiKey).toBe("xdg-token");
      expect(cfg!.oauth).toBeTruthy();
      expect(Array.isArray(cfg!.models) && cfg!.models.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
      if (prevDevin === undefined) delete process.env.DEVIN_API_KEY;
      else process.env.DEVIN_API_KEY = prevDevin;
      if (prevSess === undefined) delete process.env.DEVIN_SESSION_TOKEN;
      else process.env.DEVIN_SESSION_TOKEN = prevSess;
      if (prevWind === undefined) delete process.env.WINDSURF_API_KEY;
      else process.env.WINDSURF_API_KEY = prevWind;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapeDevinApiKeyLiteral doubles dollar signs for Pi config", async () => {
    const { escapeDevinApiKeyLiteral, resolveDevinApiKeyConfig } = await import("../src/devin/register.js");
    expect(escapeDevinApiKeyLiteral("devin-session-token$abc")).toBe("devin-session-token$$abc");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "ns-pi-devin-esc-"));
    const credPath = join(dir, "credentials.toml");
    writeFileSync(credPath, 'windsurf_api_key = "devin-session-token$raw-secret"\n', "utf8");
    try {
      expect(resolveDevinApiKeyConfig({}, { paths: [credPath] })).toBe("devin-session-token$$raw-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
