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
