import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32 } from "../src/kiro/eventstream.js";
import { createKiroStream } from "../src/kiro/stream-oauth.js";

const noopLogger = { debug() {}, warn() {}, error() {}, flush: () => Promise.resolve() };

function encodeHeaders(headers: Record<string, string>): Uint8Array {
  const parts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = new TextEncoder().encode(name);
    const valueBytes = new TextEncoder().encode(value);
    parts.push(nameBytes.length, ...nameBytes, 7, valueBytes.length >> 8, valueBytes.length & 0xff, ...valueBytes);
  }
  return new Uint8Array(parts);
}

function frame(eventType: string, payload: unknown): Uint8Array {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const headers = encodeHeaders({
    ":message-type": "event",
    ":event-type": eventType,
    ":content-type": "application/json",
  });
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

function streamResponse(frames: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const config = {
  providerId: "kiro",
  upstreamUrl: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  apiKey: "test-token",
  requestTimeoutMs: 5_000,
  headers: {},
};

const model = {
  id: "claude-sonnet-4.5",
  name: "claude-sonnet-4.5",
  api: "kiro-api",
  provider: "kiro",
  baseUrl: "https://q.us-east-1.amazonaws.com/",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

const bashTool = {
  name: "bash",
  description: "Execute a bash command.",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

// pi's normalizeContext() folds systemPrompt+tools into a leading system
// message — providers must replay toolsAdded, not read context.tools.
const transcriptContext = {
  messages: [
    {
      role: "system",
      content: "You are a test assistant.",
      toolsAdded: [bashTool],
      timestamp: 0,
    },
    { role: "user", content: "run pwd", timestamp: 1 },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kiro transcript protocol", () => {
  it("sends toolsAdded and the system prompt from system messages", async () => {
    let captured = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return streamResponse([frame("assistantResponseEvent", { content: "ok" })]);
    });

    const stream = createKiroStream(config as never, {}, noopLogger as never)(model as never, transcriptContext as never, {});
    const result = await stream.result();

    const body = JSON.parse(captured);
    const uim = body.conversationState.currentMessage.userInputMessage;
    const toolNames = (uim.userInputMessageContext?.tools ?? []).map(
      (t: { toolSpecification: { name: string } }) => t.toolSpecification.name,
    );
    expect(toolNames).toContain("bash");
    // System prompt is folded into history as a user message + ack pair.
    const history = body.conversationState.history;
    expect(history[0].userInputMessage.content).toContain("You are a test assistant.");
    expect(result.stopReason).toBe("stop");
  });

  it("still honors legacy context.tools when present", async () => {
    let captured = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return streamResponse([frame("assistantResponseEvent", { content: "ok" })]);
    });

    const context = {
      systemPrompt: "legacy prompt",
      tools: [bashTool],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    };
    const stream = createKiroStream(config as never, {}, noopLogger as never)(model as never, context as never, {});
    await stream.result();

    const body = JSON.parse(captured);
    const uim = body.conversationState.currentMessage.userInputMessage;
    expect(uim.userInputMessageContext?.tools?.[0]?.toolSpecification?.name).toBe("bash");
  });

  it("emits toolcall events when upstream returns toolUseEvent", async () => {
    vi.stubGlobal("fetch", async () =>
      streamResponse([
        frame("toolUseEvent", { name: "bash", toolUseId: "tu_1", input: '{"command":"pwd"}' }),
        frame("toolUseEvent", { name: "bash", toolUseId: "tu_1", stop: true }),
      ]),
    );

    const stream = createKiroStream(config as never, {}, noopLogger as never)(model as never, transcriptContext as never, {});
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    const call = result.content.find((b) => b.type === "toolCall") as { name?: string; arguments?: unknown } | undefined;
    expect(call?.name).toBe("bash");
    expect(call?.arguments).toEqual({ command: "pwd" });
  });
});
