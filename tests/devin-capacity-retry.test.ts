import { describe, expect, it } from "vitest";
import { streamDevin } from "../src/devin/stream.ts";

/** Minimal protobuf + connect-frame helpers matching protocol.ts wire format. */
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
function varintField(num: number, value: number | bigint): Buffer {
	return Buffer.concat([varint(num << 3), varint(value)]);
}
function frame(flags: number, payload: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(payload.length);
	return Buffer.concat([Buffer.from([flags]), len, payload]);
}
const dataFrame = (payload: Buffer) => frame(0, payload);
const trailerFrame = (message: string) =>
	frame(2, Buffer.from(JSON.stringify({ error: { message } })));

const CAPACITY_MSG = "We are currently experiencing capacity issues with this serving model. Please switch to a different model or try again later.";

const model = {
	id: "swe-2-high",
	name: "SWE-2 High",
	api: "devin-cloud",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262000,
	maxTokens: 64000,
} as never;

const context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
} as never;

function makeFetch(chatBodies: Array<Buffer | { status: number; body: string }>) {
	const calls: string[] = [];
	const fetchImpl = (async (url: string) => {
		calls.push(url);
		if (url.includes("GetUserJwt")) {
			return new Response(stringField(1, "jwt-token") as unknown as BodyInit);
		}
		const next = chatBodies.shift();
		if (Buffer.isBuffer(next)) return new Response(next as unknown as BodyInit);
		if (next) return new Response(next.body, { status: next.status });
		throw new Error("unexpected extra chat request");
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

async function collect(stream: ReturnType<typeof streamDevin>) {
	const events: Array<Record<string, unknown>> = [];
	for await (const ev of stream) events.push(ev as Record<string, unknown>);
	return events;
}

describe("devin capacity retry", () => {
	it("retries a trailer-only capacity error and completes on the next attempt", async () => {
		const { calls, fetchImpl } = makeFetch([
			trailerFrame(CAPACITY_MSG),
			dataFrame(Buffer.concat([stringField(3, "hello"), varintField(5, 0)])),
		]);
		const events = await collect(
			streamDevin(model, context, { apiKey: "k", fetch: fetchImpl, sessionId: "s" } as never),
		);
		const chatCalls = calls.filter((u) => u.includes("GetChatMessage"));
		expect(chatCalls).toHaveLength(2);
		expect(events[0]?.type).toBe("start");
		expect(events.filter((e) => e.type === "start")).toHaveLength(1);
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		const message = done?.message as { content: Array<{ text: string }> };
		expect(message.content[0]?.text).toBe("hello");
	}, 15000);

	it("does not retry a capacity trailer after content was already emitted", async () => {
		const { calls, fetchImpl } = makeFetch([
			Buffer.concat([dataFrame(stringField(3, "partial")), trailerFrame(CAPACITY_MSG)]),
		]);
		const events = await collect(
			streamDevin(model, context, { apiKey: "k", fetch: fetchImpl, sessionId: "s" } as never),
		);
		expect(calls.filter((u) => u.includes("GetChatMessage"))).toHaveLength(1);
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect((last?.error as { errorMessage?: string })?.errorMessage).toContain("capacity issues");
	});

	it("retries a 503 HTTP response before any stream starts", async () => {
		const { calls, fetchImpl } = makeFetch([
			{ status: 503, body: "capacity issues" },
			dataFrame(Buffer.concat([stringField(3, "ok"), varintField(5, 0)])),
		]);
		const events = await collect(
			streamDevin(model, context, { apiKey: "k", fetch: fetchImpl, sessionId: "s" } as never),
		);
		expect(calls.filter((u) => u.includes("GetChatMessage"))).toHaveLength(2);
		expect(events.at(-1)?.type).toBe("done");
	}, 15000);
});
