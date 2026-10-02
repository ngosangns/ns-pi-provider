/**
 * Shared HTTP helpers for provider discovery and auth.
 * Intentionally thin so providers can inject fetch for tests.
 */

export type FetchLike = typeof fetch;

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export class HttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly etag?: string;

  constructor(status: number, bodyText: string, etag?: string) {
    super(`HTTP ${status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.bodyText = bodyText;
    this.etag = etag;
  }
}

export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeout = options.timeoutMs
    ? AbortSignal.timeout(options.timeoutMs)
    : undefined;
  const signal =
    options.signal && timeout
      ? AbortSignal.any([options.signal, timeout])
      : (options.signal ?? timeout);

  return fetchImpl(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
    signal,
  });
}

export async function httpJson<T>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<{ data: T; etag?: string; status: number }> {
  const response = await httpRequest(url, options);
  const etag = response.headers.get("etag") ?? undefined;
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, text, etag);
  }
  if (!text) {
    return { data: undefined as T, etag, status: response.status };
  }
  return { data: JSON.parse(text) as T, etag, status: response.status };
}
