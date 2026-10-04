// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
// Dynamic model discovery against Kiro's ListAvailableModels operation.
//
// The provider keeps no static model catalog: this module asks the API what
// *this* key can actually reach and builds the model list from the response,
// so the offered set always matches the org's region and entitlement.
//
// Discovery is authoritative: if the call fails we surface the error rather
// than silently falling back to a static catalog. A stale fallback would
// both offer models the org cannot use and hide ones it can, which is the
// exact failure mode dynamic discovery exists to prevent.

import { log } from "./debug.ts";
import { defaultThinkingLevelMapForModel, type ThinkingLevelMap } from "./config.ts";

/**
 * `origin` filters ListAvailableModels server-side and must match what the
 * stream path sends on GenerateAssistantResponse, or we would advertise
 * models the chat path cannot actually use.
 */
const KIRO_ORIGIN = "AI_EDITOR";

/** A discovered Kiro model in pi's dash-form ID convention. */
export interface KiroModel {
  id: string;
  name: string;
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Note the service prefix: the list operation lives on
 * `AmazonCodeWhispererService`, NOT the `AmazonCodeWhispererStreamingService`
 * used for GenerateAssistantResponse. The streaming prefix answers this
 * target with UnknownOperationException.
 */
const LIST_TARGET = "AmazonCodeWhispererService.ListAvailableModels";

/** Discovery blocks startup, so it gets a tight bound of its own. */
const LIST_TIMEOUT_MS = 15_000;

/** Shape of the subset of ListAvailableModels we consume. */
interface ApiModel {
  modelId: string;
  modelName?: string;
  description?: string;
  supportedInputTypes?: string[];
  rateMultiplier?: number;
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
}

interface ListResponse {
  defaultModel?: ApiModel;
  models?: ApiModel[];
}

function buildUserAgent(): string {
  const mid = crypto.randomUUID().replace(/-/g, "");
  return `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
}

/** Convert a Kiro dot-form ID to pi's dash form (4.6 → 4-6). */
function toPiId(kiroId: string): string {
  return kiroId.replace(/(\d)\.(\d)/g, "$1-$2");
}

function toKiroModel(api: ApiModel, baseUrl: string): KiroModel {
  const piId = toPiId(api.modelId);
  const thinkingLevelMap = defaultThinkingLevelMapForModel(piId, api.modelName ?? piId);
  const types = api.supportedInputTypes ?? ["TEXT"];
  const input: ("text" | "image")[] = types.some((t) => t.toUpperCase() === "IMAGE")
    ? ["text", "image"]
    : ["text"];

  return {
    id: piId,
    name: api.modelName ?? piId,
    api: "kiro-api",
    provider: "kiro",
    baseUrl,
    // The API reports no reasoning capability flag. Treat every model as
    // reasoning-capable: an over-eager `reasoning` flag is far cheaper than
    // suppressing reasoning on a model that supports it.
    reasoning: true,
    input,
    // Kiro bills in credits via rateMultiplier, not per-token USD. There is
    // no token price to report, so cost stays zero.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: api.tokenLimits?.maxInputTokens ?? 200_000,
    maxTokens: api.tokenLimits?.maxOutputTokens ?? 8_192,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

/**
 * Ask Kiro which models this API key may use. Throws on any failure —
 * callers must not substitute a static list (see module header).
 */
export async function discoverKiroModels(
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<KiroModel[]> {
  const ua = buildUserAgent();
  const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  log.debug("discover.request", { baseUrl, origin: KIRO_ORIGIN });

  // ksk_ API keys need `tokentype: API_KEY`. OAuth/IdC/desktop bearers must
  // omit it — sending API_KEY with an SSO access token yields HTTP 403
  // "bearer token ... is invalid" even when the token is fresh.
  const headers: Record<string, string> = {
    "Content-Type": "application/x-amz-json-1.0",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Amz-Target": LIST_TARGET,
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1; max=1",
    "x-amz-user-agent": ua,
    "user-agent": ua,
  };
  if (apiKey.startsWith("ksk_")) {
    headers.tokentype = "API_KEY";
  }

  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: "POST",
      headers,
      // `origin` filters the result server-side and must match what
      // stream.ts sends on GenerateAssistantResponse, or we would advertise
      // models the chat path cannot actually use.
      body: JSON.stringify({ origin: KIRO_ORIGIN }),
      signal: combined,
    });
  } catch (err) {
    const reason = timeout.aborted
      ? `timed out after ${LIST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`Kiro model discovery failed: ${reason}`);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      detail = "";
    }
    log.debug("discover.error", { status: response.status, body: detail });
    throw new Error(
      `Kiro model discovery failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  const payload = (await response.json()) as ListResponse;
  const apiModels = payload.models ?? [];
  if (apiModels.length === 0) {
    throw new Error(
      "Kiro model discovery returned no models for this API key. " +
        "The key may lack model entitlements, or be scoped to another region.",
    );
  }

  const models = apiModels
    .filter((m) => typeof m.modelId === "string" && m.modelId.length > 0)
    .map((m) => toKiroModel(m, baseUrl));

  log.info("discover.ok", {
    count: models.length,
    discovered: models.map((m) => m.id),
    defaultModel: payload.defaultModel?.modelId,
  });

  return models;
}
