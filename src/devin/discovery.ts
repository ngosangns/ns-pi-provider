// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { gunzipSync } from "node:zlib";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildUserJwtRequest, DEVIN_HOST } from "./protocol.ts";

const DISCOVERY_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const REASONING_LABEL = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL = /\bno thinking\b/i;

export async function discoverDevinModels(apiKey: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Model<Api>[]> {
	const response = await fetchImpl(`${DEVIN_HOST}${DISCOVERY_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
		body: buildUserJwtRequest(apiKey),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error(`Devin model discovery failed: ${response.status}`);
	const payload = Buffer.from(await response.arrayBuffer());
	return decodeDiscoveredDevinModels(payload);
}

export function decodeDiscoveredDevinModels(payload: Uint8Array): Model<Api>[] {
	let bytes = Buffer.from(payload);
	try { return normalizeConfigs(fields(bytes).filter(field => field.number === 1 && field.wire === 2).map(field => field.value as Buffer)); }
	catch { bytes = gunzipSync(bytes); return normalizeConfigs(fields(bytes).filter(field => field.number === 1 && field.wire === 2).map(field => field.value as Buffer)); }
}

function normalizeConfigs(configs: Buffer[]): Model<Api>[] {
	const models = new Map<string, Model<Api>>();
	for (const config of configs) {
		const values = new Map(fields(config).map(field => [field.number, field]));
		const id = string(values.get(22)?.value).trim();
		if (!id || number(values.get(4)?.value) !== 0) continue;
		const name = string(values.get(1)?.value).trim() || id;
		const contextWindow = number(values.get(18)?.value) || DEFAULT_CONTEXT_WINDOW;
		models.set(id, {
			id, name, api: "devin-cloud", provider: "devin", baseUrl: DEVIN_HOST,
			reasoning: !NO_REASONING_LABEL.test(name) && REASONING_LABEL.test(name),
			input: number(values.get(5)?.value) ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow, maxTokens: Math.min(contextWindow, DEFAULT_MAX_TOKENS),
		});
	}
	return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

type Field = { number: number; wire: number; value: Buffer | bigint };

function fields(buffer: Buffer): Field[] {
	const result: Field[] = [];
	let offset = 0;
	while (offset < buffer.length) {
		const key = readVarint(buffer, offset); offset = key.offset;
		const number = Number(key.value >> 3n), wire = Number(key.value & 7n);
		if (wire === 0) { const value = readVarint(buffer, offset); offset = value.offset; result.push({ number, wire, value: value.value }); }
		else if (wire === 2) { const length = readVarint(buffer, offset); offset = length.offset; const end = offset + Number(length.value); if (end > buffer.length) throw new Error("Invalid Devin model discovery protobuf"); result.push({ number, wire, value: buffer.subarray(offset, end) }); offset = end; }
		else if (wire === 1) offset += 8;
		else if (wire === 5) offset += 4;
		else throw new Error(`Unsupported Devin model discovery wire type ${wire}`);
	}
	return result;
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; offset: number } {
	let value = 0n, shift = 0n;
	while (offset < buffer.length) {
		const byte = buffer[offset++]; value |= BigInt(byte & 127) << shift;
		if (!(byte & 128)) return { value, offset };
		shift += 7n;
	}
	throw new Error("Truncated Devin model discovery protobuf");
}

function string(value: Buffer | bigint | undefined): string { return Buffer.isBuffer(value) ? value.toString("utf8") : ""; }
function number(value: Buffer | bigint | undefined): number { return typeof value === "bigint" ? Number(value) : 0; }
