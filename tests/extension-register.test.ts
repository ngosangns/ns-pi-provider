import { describe, it, expect, vi } from "vitest";
import { registerAllProviders } from "../src/extension.js";

function mockPi() {
  const providers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const handlers: Array<{ event: string; fn: Function }> = [];
  return {
    providers,
    commands,
    handlers,
    api: {
      registerProvider: vi.fn((id: string, config: unknown) => {
        providers.set(id, config);
      }),
      unregisterProvider: vi.fn(),
      registerCommand: vi.fn((name: string, def: unknown) => {
        commands.set(name, def);
      }),
      on: vi.fn((event: string, fn: Function) => {
        handlers.push({ event, fn });
      }),
      events: { on: vi.fn(), emit: vi.fn() },
    },
  };
}

describe("extension registration", () => {
  it("registers kiro, devin, grok without crashing when creds missing", () => {
    const { api, providers, commands } = mockPi();
    // Should not throw
    registerAllProviders(api as never, {});
    expect(providers.has("kiro")).toBe(true);
    expect(providers.has("devin")).toBe(true);
    expect(providers.has("grok")).toBe(true);
    expect(commands.has("ns-pi")).toBe(true);

    for (const id of ["kiro", "devin", "grok"] as const) {
      const cfg = providers.get(id) as { models: Array<{ cost: { cacheRead: number; cacheWrite: number } }> };
      expect(Array.isArray(cfg.models)).toBe(true);
      expect(cfg.models.length).toBeGreaterThan(0);
      for (const m of cfg.models) {
        expect(m.cost).toHaveProperty("cacheRead");
        expect(m.cost).toHaveProperty("cacheWrite");
      }
    }
  });

  it("can disable individual providers", () => {
    const { api, providers } = mockPi();
    registerAllProviders(api as never, { kiro: false, grok: false });
    expect(providers.has("kiro")).toBe(false);
    expect(providers.has("grok")).toBe(false);
    expect(providers.has("devin")).toBe(true);
  });
});
