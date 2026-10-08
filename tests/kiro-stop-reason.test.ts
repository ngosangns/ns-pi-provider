import { isContextOverflow } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32 } from "../src/kiro/eventstream.js";
import { createKiroStream } from "../src/kiro/stream-oauth.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, flush: () => Promise.resolve() };

function encodeHeaders(headers: Record<string, string>): Uint8Array {
  const parts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = new TextEncoder().encode(name);
    const valueBytes = new TextEncoder().encode(value);
    parts.push(nameBytes.length, ...nameBytes, 7, valueBytes.length >> 8, valueBytes.length & 0xff, ...valueBytes);
  }
  return new Uint8Array(parts);
}

function rawFrame(headerMap: Record<string, string>, payload: unknown): Uint8Array {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const headers = encodeHeaders(headerMap);
  const total = 12 + headers.length + payloadBytes.length + 4;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  buf.set(headers, 12);
  buf.set(payloadBytes, 12 + headers.length);
  view.setUint32(8, crc32(buf.subarray(0, 8)));
  view.setUint32(total - 4, crc32(buf.subarray(0, total - 4)));
  return buf;
}

const frame = (eventType: string, payload: unknown) =>
  rawFrame({ ":message-type": "event", ":event-type": eventType, ":content-type": "application/json" }, payload);

function streamResponse(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(f);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const config = {
  providerId: "kiro",
  upstreamUrl: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  apiKey: "test-token",
  requestTimeoutMs: 5_000,
  headers: {},
};

const model = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "kiro-api",
  provider: "kiro",
  baseUrl: "https://q.us-east-1.amazonaws.com/",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

async function run(frames: Uint8Array[]) {
  vi.stubGlobal("fetch", async () => streamResponse(frames));
  const stream = createKiroStream(config as never, {}, noopLogger as never)(model as never, context as never, {});
  const events: Array<{ type: string; reason?: string }> = [];
  for await (const event of stream) events.push(event as { type: string; reason?: string });
  return { result: await stream.result(), events };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kiro metadataEvent stop reasons", () => {
  it("END_TURN settles a text turn as stop", async () => {
    const { result } = await run([
      frame("assistantResponseEvent", { content: "hello" }),
      frame("metadataEvent", { stopReason: "END_TURN" }),
    ]);
    expect(result.stopReason).toBe("stop");
  });

  it("TOOL_USE with a tool call is toolUse", async () => {
    const { result } = await run([
      frame("toolUseEvent", { name: "bash", toolUseId: "tu_1", input: '{"command":"pwd"}' }),
      frame("toolUseEvent", { name: "bash", toolUseId: "tu_1", stop: true }),
      frame("metadataEvent", { stopReason: "TOOL_USE" }),
    ]);
    expect(result.stopReason).toBe("toolUse");
  });

  it("MAX_TOKENS reports length even when a (truncated) tool call parsed", async () => {
    const { result, events } = await run([
      frame("assistantResponseEvent", { content: "Let me write it." }),
      frame("toolUseEvent", { name: "write", toolUseId: "tu_9", input: '{"path":"a.txt","content":"partial' }),
      frame("metadataEvent", { stopReason: "MAX_TOKENS" }),
    ]);
    // Pi/OMP agent loops refuse to execute tool calls from a `length` turn.
    expect(result.stopReason).toBe("length");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
    const call = result.content.find((b) => b.type === "toolCall") as { arguments?: unknown } | undefined;
    expect(call?.arguments).toEqual({});
  });

  it("MAX_TOKENS on a text-only turn is length", async () => {
    const { result } = await run([
      frame("assistantResponseEvent", { content: "a long answer that got cu" }),
      frame("metadataEvent", { stopReason: "MAX_TOKENS" }),
    ]);
    expect(result.stopReason).toBe("length");
  });

  it("CONTENT_FILTERED ends as an error and never completes the turn's tool calls", async () => {
    const { result, events } = await run([
      frame("toolUseEvent", { name: "bash", toolUseId: "tu_2", input: '{"command":"rm -rf /"}' }),
      frame("metadataEvent", { stopReason: "CONTENT_FILTERED", stopDetails: { reason: "policy", token: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" } }),
    ]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("CONTENT_FILTERED");
    expect(result.errorMessage).toContain("policy");
    expect(result.errorMessage).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(events.some((e) => e.type === "toolcall_end")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("MODEL_CONTEXT_WINDOW_EXCEEDED is an error Pi recognises as context overflow", async () => {
    const { result } = await run([frame("metadataEvent", { stopReason: "MODEL_CONTEXT_WINDOW_EXCEEDED" })]);
    expect(result.stopReason).toBe("error");
    expect(isContextOverflow(result as never)).toBe(true);
  });

  it("PAUSE_TURN is an error", async () => {
    const { result } = await run([
      frame("assistantResponseEvent", { content: "working" }),
      frame("metadataEvent", { stopReason: "PAUSE_TURN" }),
    ]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("PAUSE_TURN");
  });

  it("merges tokenUsage split across metadata frames", async () => {
    const { result } = await run([
      frame("assistantResponseEvent", { content: "hi" }),
      frame("metadataEvent", { tokenUsage: { uncachedInputTokens: 120, cacheReadInputTokens: 30 } }),
      frame("metadataEvent", { tokenUsage: { outputTokens: 7, contextUsagePercentage: 1.5 }, stopReason: "END_TURN" }),
    ]);
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toMatchObject({ input: 120, output: 7, cacheRead: 30, cacheWrite: 0, totalTokens: 157 });
  });

  it("surfaces a mid-stream exception frame as an error instead of a silent stop", async () => {
    const { result } = await run([
      frame("assistantResponseEvent", { content: "partial" }),
      rawFrame({ ":message-type": "exception", ":exception-type": "throttlingException", ":content-type": "application/json" }, { message: "Rate exceeded" }),
    ]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("throttlingException");
    expect(result.errorMessage).toContain("Rate exceeded");
  });

  it("without a metadata stop reason keeps the previous behaviour", async () => {
    const { result } = await run([frame("assistantResponseEvent", { content: "ok" })]);
    expect(result.stopReason).toBe("stop");
  });
});
