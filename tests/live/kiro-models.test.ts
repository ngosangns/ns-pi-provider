/**
 * Optional live per-model probe — gated on NS_PI_LIVE=1 and a resolvable
 * Kiro token. Streams a tiny prompt through every discovered model using
 * the real provider path (createKiroStream) and reports status per model.
 * Never prints secret material.
 *
 * NS_PI_MODEL_FILTER=id1,id2   limit probing to specific models
 * NS_PI_MODEL_TIMEOUT_MS=45000 per-model timeout
 */
import { describe, it, expect } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveKiroDiscoveryToken, refreshKiroModels } from "../../src/kiro/register.js";
import { createKiroStream } from "../../src/kiro/stream-oauth.js";
import { loadConfig } from "../../src/kiro/config.js";
import { DebugLogger } from "../../src/kiro/debug-logger.js";

const LIVE = process.env.NS_PI_LIVE === "1";
const PER_MODEL_TIMEOUT_MS = Number(process.env.NS_PI_MODEL_TIMEOUT_MS ?? 45_000);
const PROMPT = "Reply with exactly the single word: OK";
const EXTENSION_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface ModelResult {
  id: string;
  ok: boolean;
  ms: number;
  text?: string;
  stopReason?: string;
  error?: string;
}

async function probeModel(
  streamSimple: ReturnType<typeof createKiroStream>,
  model: { id: string } & Record<string, unknown>,
  token: string,
): Promise<ModelResult> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${PER_MODEL_TIMEOUT_MS}ms`)), PER_MODEL_TIMEOUT_MS);
  try {
    let text = "";
    let stopReason: string | undefined;
    let error: string | undefined;
    const stream = streamSimple(model as never, { messages: [{ role: "user", content: PROMPT } as never] }, {
      apiKey: token,
      signal: ac.signal,
    });
    for await (const ev of stream) {
      const e = ev as {
        type: string;
        delta?: string;
        reason?: string;
        error?: { errorMessage?: string; stopReason?: string; message?: string };
      };
      if (e.type === "text_delta" && e.delta) text += e.delta;
      if (e.type === "done") stopReason = e.reason ?? "stop";
      if (e.type === "error") error = e.error?.errorMessage ?? e.error?.message ?? "stream error";
    }
    return {
      id: model.id,
      ok: !error && text.trim().length > 0,
      ms: Date.now() - started,
      text: text.trim().slice(0, 80),
      stopReason,
      error,
    };
  } catch (err) {
    return {
      id: model.id,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

describe.runIf(LIVE)("live kiro models", () => {
  it(
    "streams a minimal request through every discovered model",
    async () => {
      const resolved = resolveKiroDiscoveryToken();
      if (!resolved) {
        console.info("[live] kiro: skip (no token)");
        return;
      }
      const { models } = await refreshKiroModels({ force: true, token: resolved.token });
      if (models.length === 0) {
        console.info("[live] kiro: discovery returned 0 models");
        return;
      }
      const { config } = loadConfig(EXTENSION_ROOT);
      const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: false });
      const streamSimple = createKiroStream(config, {}, logger);

      const filter = process.env.NS_PI_MODEL_FILTER?.split(",").map((s) => s.trim()).filter(Boolean);
      const targets = filter?.length ? models.filter((m) => filter.includes(m.id)) : models;
      console.info(`[live] kiro: probing ${targets.length} models via ${config.upstreamUrl} (timeout ${PER_MODEL_TIMEOUT_MS}ms each)`);

      const results: ModelResult[] = [];
      for (const model of targets) {
        const r = await probeModel(streamSimple, model as never, resolved.token);
        results.push(r);
        console.info(
          `[live] ${r.ok ? "PASS" : "FAIL"} ${r.id} (${r.ms}ms)` +
            (r.ok ? ` stop=${r.stopReason} text=${JSON.stringify(r.text)}` : ` err=${r.error}`),
        );
      }

      const passed = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      console.info(`[live] kiro summary: ${passed.length}/${results.length} models OK`);
      if (failed.length > 0) {
        console.info(`[live] kiro failures: ${failed.map((f) => `${f.id}=${f.error}`).join(" | ")}`);
      }
      // The suite only hard-fails when every model fails — individual model
      // outages (entitlement, region, capacity) are reported, not asserted.
      expect(passed.length).toBeGreaterThan(0);
    },
    20 * 60_000,
  );
});
