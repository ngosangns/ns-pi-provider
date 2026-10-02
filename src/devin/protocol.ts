// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { gunzipSync, gzipSync } from "node:zlib";
import type { Api, Context, Message, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools, withoutInitialSystemMessage } from "@earendil-works/pi-ai";

export const DEVIN_HOST = "https://server.codeium.com";
const API_KEY_PREFIX = "devin-session-token$";
const IDE_VERSION = "3.2.23";
const EXTENSION_VERSION = "1.48.2";
const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

export function normalizeSessionToken(apiKey: string): string {
	return apiKey.startsWith(API_KEY_PREFIX) ? apiKey : `${API_KEY_PREFIX}${apiKey}`;
}

export function buildUserJwtRequest(apiKey: string): Buffer {
	return message(1, encodeMetadata(normalizeSessionToken(apiKey), undefined));
}

export async function getUserJwt(apiKey: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string> {
	const metadata = encodeMetadata(normalizeSessionToken(apiKey), undefined);
	const response = await fetchImpl(`${DEVIN_HOST}/exa.auth_pb.AuthService/GetUserJwt`, {
		method: "POST",
		headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
		body: buildUserJwtRequest(apiKey),
		signal,
	});
	const payload = Buffer.from(await response.arrayBuffer());
	if (!response.ok) throw new Error(`Devin auth failed: ${response.status} ${payload.toString("utf8")}`);
	const userJwt = firstStringField(payload, 1);
	if (!userJwt) throw new Error("Devin auth returned an empty user JWT");
	return userJwt;
}

export function buildChatRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	apiKey: string,
	userJwt: string,
): Buffer {
	const cascadeId = options.sessionId ?? crypto.randomUUID();
	// After Pi's normalizeContext(), tools + system prompt live on system messages
	// (toolsAdded), not context.tools / context.systemPrompt. Built-in providers use
	// getCurrentTools(messages); we must too or swe-2 sees zero tools.
	const systemPrompt = context.systemPrompt || getCurrentSystemPrompt(context.messages) || "";
	const history = withoutInitialSystemMessage(context.messages);
	const prompts = history.flatMap(messageForWire).map((item, index) => encodePrompt(item, `${cascadeId}-${index}`));
	const toolDefs = (context.tools?.length ? context.tools : getCurrentTools(context.messages)) as Tool[];
	const tools = toolDefs.map(encodeTool);
	const configuration = concat(
		varintField(1, 1n),
		varintField(2, BigInt(options.maxTokens ?? model.maxTokens ?? 64000)),
		varintField(3, 200n),
		doubleField(5, options.temperature ?? 0.4),
		doubleField(6, options.temperature ?? 0.4),
		varintField(7, 50n),
		doubleField(8, 1),
		...[
			"<|user|>",
			"<|bot|>",
			"<|context_request|>",
			"<|endoftext|>",
			"<|end_of_turn|>",
		].map(value => stringField(9, value)),
		doubleField(11, 1),
	);
	return concat(
		message(1, encodeMetadata(normalizeSessionToken(apiKey), userJwt)),
		systemPrompt ? stringField(2, systemPrompt) : Buffer.alloc(0),
		...prompts.map(prompt => message(3, prompt)),
		varintField(7, 5n),
		message(8, configuration),
		...tools.map(tool => message(10, tool)),
		varintField(11, 1n),
		stringField(16, cascadeId),
		stringField(17, crypto.randomUUID()),
		varintField(20, 1n),
		stringField(21, model.id),
		stringField(22, crypto.randomUUID()),
	);
}

export function frameConnect(payload: Uint8Array): Buffer {
	const compressed = gzipSync(payload);
	return Buffer.concat([Buffer.from([1]), uint32(compressed.length), compressed]);
}

export type DevinFrame = { trailer: boolean; payload: Buffer };

export function parseConnectFrames(input: Uint8Array): DevinFrame[] {
	const buffer = Buffer.from(input);
	const frames: DevinFrame[] = [];
	let offset = 0;
	while (offset + 5 <= buffer.length) {
		const flags = buffer[offset];
		const length = buffer.readUInt32BE(offset + 1);
		if (length > MAX_FRAME_PAYLOAD) throw new Error(`Devin frame exceeds ${MAX_FRAME_PAYLOAD} bytes`);
		if (offset + 5 + length > buffer.length) break;
		let payload = buffer.subarray(offset + 5, offset + 5 + length);
		if (flags & 1) payload = gunzipSync(payload);
		frames.push({ trailer: Boolean(flags & 2), payload });
		offset += 5 + length;
	}
	return frames;
}

export type DevinDelta =
	| { type: "text"; value: string }
	| { type: "thinking"; value: string; signature?: string }
	/** Tool-call stream chunk. Start frames include id+name; later frames often only argumentsJson. */
	| { type: "tool"; id?: string; name?: string; argumentsJson: string }
	| { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
	| { type: "stop"; reason: number }
	| { type: "message"; id: string };

export function decodeChatResponse(payload: Uint8Array): DevinDelta[] {
	const deltas: DevinDelta[] = [];
	for (const field of fields(Buffer.from(payload))) {
		if (field.number === 1 && field.wire === 2) deltas.push({ type: "message", id: text(field.value) });
		else if (field.number === 3 && field.wire === 2) deltas.push({ type: "text", value: text(field.value) });
		else if (field.number === 5 && field.wire === 0) deltas.push({ type: "stop", reason: Number(field.value) });
		else if (field.number === 6 && field.wire === 2) deltas.push(decodeToolCall(field.value));
		else if (field.number === 7 && field.wire === 2) deltas.push(decodeUsage(field.value));
		else if (field.number === 9 && field.wire === 2) deltas.push({ type: "thinking", value: text(field.value) });
		else if (field.number === 10 && field.wire === 2) {
			const previous = deltas.at(-1);
			if (previous?.type === "thinking") previous.signature = text(field.value);
		}
	}
	return deltas;
}

export function trailerError(payload: Uint8Array): string | undefined {
	try {
		const value = JSON.parse(Buffer.from(payload).toString("utf8")) as { error?: { message?: string } };
		return value.error?.message;
	} catch {
		return undefined;
	}
}

function encodeMetadata(apiKey: string, userJwt: string | undefined): Buffer {
	return concat(
		stringField(1, "windsurf"),
		stringField(2, EXTENSION_VERSION),
		stringField(3, apiKey),
		stringField(4, "en"),
		stringField(5, process.platform),
		stringField(7, IDE_VERSION),
		varintField(9, 1n),
		stringField(10, crypto.randomUUID()),
		stringField(12, "windsurf"),
		stringField(25, crypto.randomUUID()),
		stringField(26, "Unset"),
		stringField(28, "windsurf"),
		userJwt ? stringField(21, userJwt) : Buffer.alloc(0),
	);
}

function messageForWire(message: Message): WireMessage[] {
	if (message.role === "system") return [];
	if (message.role === "user") return [{ role: 1, text: contentText(message.content) }];
	if (message.role === "toolResult") return [{ role: 4, text: contentText(message.content), toolCallId: message.toolCallId }];
	// Devin/Windsurf: user=1, assistant=2, tool=4 (see pi-devin SOURCE_BY_ROLE).
	const items: WireMessage[] = [];
	for (const content of message.content) {
		if (content.type === "text") items.push({ role: 2, text: content.text });
		else if (content.type === "thinking") items.push({ role: 2, text: content.thinking });
		else if (content.type === "toolCall") items.push({ role: 2, text: "", toolCalls: [{ id: content.id, name: content.name, argumentsJson: JSON.stringify(content.arguments) }] });
	}
	return items;
}

type WireMessage = { role: number; text: string; toolCallId?: string; toolCalls?: { id: string; name: string; argumentsJson: string }[] };

function encodePrompt(item: WireMessage, id: string): Buffer {
	return concat(
		stringField(1, id),
		varintField(2, BigInt(item.role)),
		stringField(3, item.text),
		item.toolCallId ? stringField(7, item.toolCallId) : Buffer.alloc(0),
		...(item.toolCalls ?? []).map(call => message(6, concat(stringField(1, call.id), stringField(2, call.name), stringField(3, call.argumentsJson)))),
	);
}

function encodeTool(tool: Tool): Buffer {
	const description = typeof tool.description === "string" ? tool.description : "";
	const parameters = JSON.stringify(tool.parameters) ?? "{}";
	return concat(stringField(1, tool.name), stringField(2, description.slice(0, 6998)), stringField(3, parameters));
}

function contentText(content: string | { type: "text"; text: string }[]): string {
	return typeof content === "string" ? content : content.filter(item => item.type === "text").map(item => item.text).join("\n");
}

function decodeToolCall(payload: Buffer): DevinDelta {
	const values = new Map(fields(payload).filter(field => field.wire === 2).map(field => [field.number, text(field.value)]));
	// Do NOT invent id/name for args-only frames — swe-2 streams field 3 alone after the start frame.
	return {
		type: "tool",
		id: values.get(1),
		name: values.get(2),
		argumentsJson: values.get(3) ?? "",
	};
}

/**
 * Merge streamed tool deltas into open tool calls.
 * Windsurf/swe-2 sends: (1) id+name start, then (2) many args-only chunks with only field 3.
 */
export function mergeDevinToolDeltas(
	deltas: Extract<DevinDelta, { type: "tool" }>[],
): { id: string; name: string; argumentsJson: string }[] {
	const order: string[] = [];
	const byId = new Map<string, { id: string; name: string; argumentsJson: string }>();
	let currentId: string | undefined;
	for (const delta of deltas) {
		if (delta.id && delta.name) {
			currentId = delta.id;
			if (!byId.has(delta.id)) {
				byId.set(delta.id, { id: delta.id, name: delta.name, argumentsJson: "" });
				order.push(delta.id);
			} else {
				byId.get(delta.id)!.name = delta.name;
			}
		}
		const id = delta.id ?? currentId;
		if (!id) continue;
		const open = byId.get(id);
		if (!open) continue;
		const chunk = delta.argumentsJson ?? "";
		if (!chunk) continue;
		open.argumentsJson = chunk.startsWith(open.argumentsJson) ? chunk : open.argumentsJson + chunk;
	}
	return order.map((id) => byId.get(id)!);
}

function decodeUsage(payload: Buffer): DevinDelta {
	const values = new Map(fields(payload).filter(field => field.wire === 0).map(field => [field.number, Number(field.value)]));
	return { type: "usage", input: values.get(2) ?? 0, output: values.get(3) ?? 0, cacheWrite: values.get(4) ?? 0, cacheRead: values.get(5) ?? 0 };
}

type Field = { number: number; wire: number; value: Buffer | bigint };

function fields(buffer: Buffer): Field[] {
	const result: Field[] = [];
	let offset = 0;
	while (offset < buffer.length) {
		const key = readVarint(buffer, offset);
		offset = key.offset;
		const number = Number(key.value >> 3n);
		const wire = Number(key.value & 7n);
		if (wire === 0) {
			const value = readVarint(buffer, offset);
			offset = value.offset;
			result.push({ number, wire, value: value.value });
		} else if (wire === 2) {
			const length = readVarint(buffer, offset);
			offset = length.offset;
			const end = offset + Number(length.value);
			if (end > buffer.length) throw new Error("Invalid Devin protobuf length");
			result.push({ number, wire, value: buffer.subarray(offset, end) });
			offset = end;
		} else if (wire === 1) offset += 8;
		else if (wire === 5) offset += 4;
		else throw new Error(`Unsupported Devin protobuf wire type ${wire}`);
	}
	return result;
}

function firstStringField(buffer: Buffer, number: number): string | undefined {
	const field = fields(buffer).find(item => item.number === number && item.wire === 2);
	return field ? text(field.value) : undefined;
}

function text(value: Buffer | bigint): string {
	return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function concat(...parts: Buffer[]): Buffer {
	return Buffer.concat(parts);
}

function message(number: number, value: Buffer): Buffer {
	return concat(stringKey(number), varint(Number(value.length)), value);
}

function stringField(number: number, value: string): Buffer {
	return message(number, Buffer.from(value, "utf8"));
}

function varintField(number: number, value: bigint): Buffer {
	return concat(varint(BigInt(number << 3)), varint(value));
}

function doubleField(number: number, value: number): Buffer {
	const bytes = Buffer.alloc(8);
	bytes.writeDoubleLE(value);
	return concat(Buffer.from([number * 8 + 1]), bytes);
}

function stringKey(number: number): Buffer {
	return varint(BigInt(number << 3 | 2));
}

function varint(value: number | bigint): Buffer {
	let current = BigInt(value);
	const output: number[] = [];
	while (current > 127n) {
		output.push(Number(current & 127n) | 128);
		current >>= 7n;
	}
	output.push(Number(current));
	return Buffer.from(output);
}

function uint32(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value);
	return buffer;
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; offset: number } {
	let value = 0n;
	let shift = 0n;
	while (offset < buffer.length) {
		const byte = buffer[offset++];
		value |= BigInt(byte & 127) << shift;
		if (!(byte & 128)) return { value, offset };
		shift += 7n;
		if (shift > 70n) throw new Error("Invalid Devin protobuf varint");
	}
	throw new Error("Truncated Devin protobuf varint");
}
