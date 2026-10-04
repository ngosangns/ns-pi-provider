## 0.1.8

- fix(kiro): convert wire `modelId` to Kiro's dot form — discovery returns pi dash-form IDs (`claude-sonnet-4-5`) but `GenerateAssistantResponse` requires dot form (`claude-sonnet-4.5`), so every discovered model failed with `INVALID_MODEL_ID` on stream.
- refactor(kiro): drop the package-shipped model catalog — `ListAvailableModels` is now the sole catalog source (scoped to the key's region/org/entitlement), so the offered set can no longer drift stale. `config.json` `models` remains a user override for custom upstreams; derived `-1m` variants are no longer offered since the API does not advertise them.
- feat(kiro): await model discovery before first `registerProvider` so `--list-models` / headless `-p` see the full catalog without a `session_start` (same pattern as devin).
- feat(kiro): carry `thinkingLevelMap` through discovered models (opus 4.6/4.7 thinking levels incl. `xhigh`) via a client-side name heuristic — the API does not report it.
- chore(kiro): remove vendored dead code (`stream.ts` + `tokenizer.ts`/`thinking-parser.ts`/`event-parser.ts`/`transform.ts`/`models.ts`) that pinned the static catalog and was never wired into the provider.
- test(kiro): add live per-model probe (`tests/live/kiro-models.test.ts`) streaming a minimal request through every discovered model; opt-in via `NS_PI_LIVE=1`, `NS_PI_MODEL_FILTER`, `NS_PI_MODEL_TIMEOUT_MS`.

## 0.1.7

- fix(kiro): read tools/system prompt via `getCurrentTools` / `getCurrentSystemPrompt` after Pi `normalizeContext` — `context.tools`/`context.systemPrompt` are empty once the transcript protocol folds them into a leading system message, so Kiro requests went out with zero tools and no system prompt (models answered in plain text and hallucinated command output). Same root cause as the devin fix in 0.1.5.
- fix(grok): answer agent→client JSON-RPC requests — `_x.ai/ask_user_question` gets `{cancelled:true}`, `session/request_permission` auto-selects an `allow_*` option (matches `--always-approve`), unknown methods get `-32601`. Previously unanswered requests blocked the agent forever (`pi auth check`/headless hangs).
- fix(grok): resolve the system prompt from transcript system messages in prompt building and history fingerprints (same transcript-protocol drop).

## 0.1.6

- fix(devin): retry serving-model capacity pressure — trailer-only "capacity issues" errors and HTTP 503 before any emitted content now retry with exponential backoff (5s → 10s → 20s, max 3) instead of failing the stream outright; mid-stream capacity trailers still surface as errors to avoid replaying emitted deltas.
- chore: enable `allowImportingTsExtensions` so `npm run typecheck` covers the `.ts`-extension imports used across src/tests (unblocks `prepublishOnly`).

## 0.1.5

- fix(devin): read tools/system prompt via `getCurrentTools` / `getCurrentSystemPrompt` after Pi `normalizeContext` (tools live on system `toolsAdded`, so `context.tools` was always empty under RPC).
- fix(devin): assemble swe-2 streamed tool calls — args-only protobuf frames no longer mint a new id/name (`tool`), so bash/read/edit/write actually execute under Pi RPC.
- fix(devin): encode assistant history as role `2` (user=1, tool=4); treat stop reason `10` as `toolUse`.

## 0.1.4

- Republish of 0.1.3 (Devin await catalog before register) after npm staged-version conflict.

# Changelog

## 0.1.3

- fix(devin): await `refreshDevinModels` in async extension factory before first `registerProvider`, so `pi --list-models` / `-p` see discovered models (e.g. `swe-2-medium`/`high`/`max`) without interactive `session_start`.

## 0.1.2

- fix(devin): escape `$` in CLI session tokens when seeding Pi `apiKey` (`devin-session-token$…` → `$$`) so `--list-models` marks Devin configured.

## 0.1.1

- fix(kiro): OAuth discovery — omit `tokentype=API_KEY` for IdC/SSO bearers so model listing works with Builder ID / Google / GitHub sessions.
- fix(devin): resolve CLI `credentials.toml` (`windsurf_api_key`) for model registration and auth without requiring a prior `/login` when credentials already exist (Pi `--list-models` no longer needs a `devin` entry in `auth.json`).

## 0.1.0

- Initial unified package registering `kiro`, `devin`, and `grok` providers.
- Disk TTL + ETag/version model catalog cache shared across providers.
- `/ns-pi refresh|status` command and per-provider refresh hooks.
- Hermetic vitest coverage for cache hits, auth resolve, model mapping.
