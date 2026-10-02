import { describe, it, expect, vi } from "vitest";
import { httpJson, HttpError } from "../src/shared/http.js";
import { firstEnv, redact, readEnv } from "../src/shared/credentials.js";

describe("shared http + credentials", () => {
  it("httpJson returns parsed body and etag", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { etag: '"abc"' },
      }),
    ) as unknown as typeof fetch;
    const result = await httpJson<{ ok: boolean }>("https://example.test/models", {
      fetchImpl,
      method: "GET",
    });
    expect(result.data.ok).toBe(true);
    expect(result.etag).toBe('"abc"');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("httpJson throws HttpError on non-OK", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(httpJson("https://example.test", { fetchImpl })).rejects.toBeInstanceOf(HttpError);
  });

  it("credential helpers never expose full secrets via redact", () => {
    expect(readEnv("MISSING", {})).toBeUndefined();
    expect(firstEnv(["A", "B"], { B: "  secret-value-here  " })).toBe("secret-value-here");
    const r = redact("abcdefghijklmnop");
    expect(r).not.toContain("efghijkl");
    expect(r.includes("…") || r === "***").toBe(true);
  });
});
