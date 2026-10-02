# @ngosangns/ns-pi-provider

Unified [Pi](https://pi.dev) coding-agent providers for **Kiro**, **Devin**, and **Grok**.

- Provider ids: `kiro`, `devin`, `grok`
- Auth: OAuth and/or CLI / API-key where each upstream supports it
- Streaming + reasoning/thinking where supported
- **Auto-updating model catalogs** with disk TTL cache (and ETag/version when available)
- Commands: `/ns-pi refresh [all|kiro|devin|grok]`, `/ns-pi status`, plus `/grok`, `/devin-status`

## Install in Pi

```bash
# from npm (after publish)
pi install npm:@ngosangns/ns-pi-provider

# from git
pi install git:github.com/ngosangns/ns-pi-provider@main

# local path
pi install /path/to/ns-pi-provider

# one-shot
pi -e npm:@ngosangns/ns-pi-provider
```

Then `/login kiro` or `/login devin` as needed. Grok uses the local `grok` CLI / `~/.grok` auth (or `XAI_API_KEY`).

## Architecture

| Provider | Auth | Model refresh | Stream |
|----------|------|---------------|--------|
| **kiro** | OAuth (Builder ID / Google / GitHub) + `KIRO_API_KEY` / SSO cache tokens | `ListAvailableModels` → catalog cache | CodeWhisperer eventstream |
| **devin** | OAuth (`/login devin`) + `credentials.toml` / env | `GetCliModelConfigs` → catalog cache | Devin cloud Connect protocol |
| **grok** | Grok CLI / `~/.grok/auth.json` / `XAI_API_KEY` | `grok models` CLI → catalog cache | ACP or JSONL via local CLI |

Shared modules under `src/shared/` provide HTTP helpers, credential env resolution, and `CatalogCache` (TTL + optional ETag, in-memory + `~/.pi/agent/cache/ns-pi-provider`).

Subpath exports (tree-shakeable):

```ts
import { registerKiroProvider } from "@ngosangns/ns-pi-provider/kiro";
import { registerDevinProvider } from "@ngosangns/ns-pi-provider/devin";
import { registerGrokProvider } from "@ngosangns/ns-pi-provider/grok";
```

## Development

```bash
npm install
npm test          # hermetic unit/integration tests
npm run typecheck
NS_PI_LIVE=1 npm run test:live   # optional live smoke when creds present
```

## Publish

Tag a release (`v0.1.0`) to run publish workflow (templates under `docs/github-workflows/`; copy into `.github/workflows/` after granting the `workflow` OAuth scope).

- **npm**: set repository secret `NPM_TOKEN`
- **GitHub Packages**: uses `GITHUB_TOKEN` (scoped `@ngosangns`)

## Attribution

See [NOTICE](./NOTICE) for upstream MIT projects this package adapts (pi-kiro-provider, pi-kiro-api, pi-devin-provider, pi-grok-sdk, and Pi docs/examples).

## License

MIT
