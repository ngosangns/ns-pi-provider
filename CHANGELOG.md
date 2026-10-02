# Changelog

## 0.1.0

- Initial unified package registering `kiro`, `devin`, and `grok` providers.
- Disk TTL + ETag/version model catalog cache shared across providers.
- `/ns-pi refresh|status` command and per-provider refresh hooks.
- Hermetic vitest coverage for cache hits, auth resolve, model mapping.
