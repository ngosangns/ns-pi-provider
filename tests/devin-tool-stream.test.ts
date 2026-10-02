import { describe, expect, it } from "vitest";
import { decodeChatResponse, mergeDevinToolDeltas } from "../src/devin/protocol.ts";

/** Minimal protobuf helpers matching protocol.ts encoding. */
function varint(value: number | bigint): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  while (n >= 0x80n) {
    bytes.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}
function stringField(num: number, value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([varint((num << 3) | 2), varint(body.length), body]);
}
function messageField(num: number, value: Buffer): Buffer {
  return Buffer.concat([varint((num << 3) | 2), varint(value.length), value]);
}
function chatFrameWithTool(toolPayload: Buffer): Buffer {
  return messageField(6, toolPayload);
}

describe("devin swe-2 tool stream decode", () => {
  it("does not invent id/name for args-only frames", () => {
    const start = chatFrameWithTool(
      Buffer.concat([
        stringField(1, "call_abc#1"),
        stringField(2, "bash"),
      ]),
    );
    const argOnly = chatFrameWithTool(stringField(3, '{"command":"ls"}'));

    const startDelta = decodeChatResponse(start).find((d) => d.type === "tool");
    const argDelta = decodeChatResponse(argOnly).find((d) => d.type === "tool");

    expect(startDelta).toEqual({
      type: "tool",
      id: "call_abc#1",
      name: "bash",
      argumentsJson: "",
    });
    expect(argDelta).toEqual({
      type: "tool",
      id: undefined,
      name: undefined,
      argumentsJson: '{"command":"ls"}',
    });
  });

  it("merges swe-2 style streamed args onto the open tool call", () => {
    const deltas = [
      { type: "tool" as const, id: "call_1", name: "bash", argumentsJson: "" },
      { type: "tool" as const, argumentsJson: "{" },
      { type: "tool" as const, argumentsJson: '"command": "' },
      { type: "tool" as const, argumentsJson: "ls /tmp | head" },
      { type: "tool" as const, argumentsJson: '"' },
      { type: "tool" as const, argumentsJson: "}" },
    ];
    const merged = mergeDevinToolDeltas(deltas);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      id: "call_1",
      name: "bash",
      argumentsJson: '{"command": "ls /tmp | head"}',
    });
    expect(JSON.parse(merged[0].argumentsJson)).toEqual({
      command: "ls /tmp | head",
    });
  });

  it("supports multiple sequential tool calls", () => {
    const deltas = [
      { type: "tool" as const, id: "a", name: "read", argumentsJson: "" },
      { type: "tool" as const, argumentsJson: '{"path":"a.ts"}' },
      { type: "tool" as const, id: "b", name: "bash", argumentsJson: "" },
      { type: "tool" as const, argumentsJson: '{"command":"pwd"}' },
    ];
    const merged = mergeDevinToolDeltas(deltas);
    expect(merged.map((t) => t.name)).toEqual(["read", "bash"]);
    expect(JSON.parse(merged[0].argumentsJson)).toEqual({ path: "a.ts" });
    expect(JSON.parse(merged[1].argumentsJson)).toEqual({ command: "pwd" });
  });
});

describe("buildChatRequest reads tools from transcript", () => {
  it("encodes tools from system toolsAdded when context.tools is empty", async () => {
    const { buildChatRequest, normalizeSessionToken } = await import("../src/devin/protocol.ts");
    const { normalizeContext } = await import("@earendil-works/pi-ai");

    const raw = {
      systemPrompt: "You are a coding agent.",
      messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
      tools: [
        {
          name: "bash",
          description: "Run shell",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    };
    const normalized = normalizeContext(raw);
    // Mimic model-runtime: only messages remain at top level
    expect((normalized as { tools?: unknown }).tools).toBeUndefined();
    expect(normalized.messages[0]?.role).toBe("system");

    const model = {
      id: "swe-2-high",
      name: "SWE-2 High",
      api: "devin-cloud" as const,
      provider: "devin",
      baseUrl: "https://server.codeium.com",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262000,
      maxTokens: 64000,
    };
    const body = buildChatRequest(
      model as never,
      normalized as never,
      { maxTokens: 100, sessionId: "test-session" },
      normalizeSessionToken("test-key"),
      "jwt",
    );
    // Count field 10 (tools) at top level
    let n = 0, off = 0;
    const buf = body;
    while (off < buf.length) {
      let v = 0n, s = 0n;
      while (off < buf.length) {
        const b = buf[off++];
        v |= BigInt(b & 127) << s;
        if (!(b & 128)) break;
        s += 7n;
      }
      const num = Number(v >> 3n), wire = Number(v & 7n);
      if (num === 10) n++;
      if (wire === 0) {
        while (off < buf.length && buf[off++] & 128);
      } else if (wire === 2) {
        let len = 0n, ss = 0n;
        while (off < buf.length) {
          const b = buf[off++];
          len |= BigInt(b & 127) << ss;
          if (!(b & 128)) break;
          ss += 7n;
        }
        off += Number(len);
      } else if (wire === 1) off += 8;
      else if (wire === 5) off += 4;
      else break;
    }
    expect(n).toBe(1);
  });
});
