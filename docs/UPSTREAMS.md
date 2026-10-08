# Upstream sync points

Code under `src/` is adapted from these MIT projects (see `NOTICE`). When
syncing, diff each upstream from the recorded point and port what fits.

| Area | Upstream | Last synced | Notes |
|------|----------|-------------|-------|
| `src/kiro/` (config, oauth-provider, stream-oauth, eventstream, headers, debug-logger, shared/) | [MasuRii/pi-kiro-provider](https://github.com/MasuRii/pi-kiro-provider) | `35fc171` (v0.2.2) | Heavily customized since (transcript tools, dot-form wire ids, discovery-only catalog). |
| `src/kiro/discover.ts`, `debug.ts` | [satiyap/pi-kiro-api](https://github.com/satiyap/pi-kiro-api) | `86c8f2d` (v0.3.0) | Static catalog / stream path removed in 0.1.8. Vendors [hongyilyu/pi-kiro](https://github.com/hongyilyu/pi-kiro) `4383273` (v0.1.3). |
| `src/devin/` | [fadlee/pi-devin-provider](https://github.com/fadlee/pi-devin-provider) | `942613e` (v0.1.0) | swe-2 tool-calling, role encoding, capacity retry are local fixes. |
| `src/grok/` | [ankitchouhan1020/pi-grok-sdk](https://github.com/ankitchouhan1020/pi-grok-sdk) | `45fde95` (post-v0.2.1) | Local: transcript system prompt, ACP agent→client requests. |
| Pi API | [`@earendil-works/pi-ai` / `pi-coding-agent`](https://github.com/earendil-works/pi) | dev `1.0.0`, verified `1.1.0` | No provider-API breaking changes in 1.0.1–1.1.0. |

Patterns only (no vendored code): `grok-pi` (luongnv89/pi-extensions), Pi docs/examples.
Sibling repos `ns-kiro-provider` / `ns-devin-provider` are independent OMP/DSH
stacks (kiro side derives from mikeyobrien/pi-provider-kiro), not upstreams of this package.
