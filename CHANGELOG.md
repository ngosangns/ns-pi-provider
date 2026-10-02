# Changelog

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
