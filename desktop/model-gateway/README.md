# Codex Multi-Model Gateway

This Node.js gateway gives Codex one Responses API endpoint while routing namespaced model IDs to Faker, Sub2API, or local OpenAI-compatible servers.

```text
Codex -> POST /v1/responses -> model registry
                               |- native Responses (transparent forwarding)
                               |- Chat Completions (protocol conversion)
                               `- Anthropic Messages (protocol conversion)
```

Requirements: Node.js 20 or newer. The gateway binds to `127.0.0.1:8787` by default.

## Configure

Create local configuration files from the safe examples:

```powershell
Copy-Item gateway.config.example.json gateway.config.json
Copy-Item .env.example ..\.env
```

Edit `gateway.config.json` so every public model maps to a real provider and upstream model. Configure at least one Provider key in `desktop/.env`; Providers without a key and models that depend only on them are skipped at startup. Configure multiple keys to load models from multiple Providers. The desktop app and standalone gateway launcher both load that file. Never put a key directly in JSON; `api_key` is rejected and `api_key_env` must reference an environment variable when that Provider is enabled.

The bundled example defines:

- `sub2api/gpt-codex` through native Responses
- `openai_legacy/coder` through Chat Completions conversion
- `claude/sonnet` through Anthropic Messages conversion

Capability values in the example are illustrative. Confirm them against each deployed model before use. A capability explicitly set to `false` is enforced with a clear 400 error.

### Equivalent-model failover

Fallbacks are opt-in and belong to a public model. Only list routes that serve the same actual model:

```json
{
  "models": {
    "team/coder": {
      "provider": "primary",
      "upstream_model": "coder-v3",
      "fallbacks": [
        { "provider": "replica", "upstream_model": "coder-v3" }
      ]
    }
  }
}
```

The gateway retries a fallback only before it sends response bytes to Codex, for connection failures, timeouts, HTTP 408/429, and 5xx responses. An interrupted SSE stream is never switched. `previous_response_id` uses an in-memory sticky route so a native Responses conversation stays on its original provider.

### Model access

Each `access` entry reads a gateway key from an environment variable and grants exact IDs, a prefix such as `local/*`, or `*`. `GET /v1/models` only returns models allowed for the supplied bearer token. A known but disallowed model returns 403.

For legacy compatibility, if `gateway.config.json` is absent the old `UPSTREAM_BASE_URL`, `UPSTREAM_CHAT_PATH`, `UPSTREAM_MODEL`, `UPSTREAM_API_KEY`, and `PROXY_API_KEY` variables still create one Chat Completions route.

## Run

```powershell
npm test
.\start-proxy.ps1
```

### Isolated Codex test configuration

Keep the normal `C:\Users\Administrator\.codex` configuration unchanged and launch a test
Codex process with a separate home directory:

```powershell
.\start-codex-test.ps1
.\start-codex-test.ps1 -m "sub2api/gpt-5.5"
```

The launcher uses `desktop/model-gateway/.codex-test` as `CODEX_HOME`, rebuilds the private model catalog,
starts the standalone gateway when needed, checks `/health`, and then launches Codex. The
environment override exists only for that process tree. Test sessions, logs, and state remain
isolated from the default Codex home.

Endpoints:

```text
GET  http://127.0.0.1:8787/health
GET  http://127.0.0.1:8787/v1/models
POST http://127.0.0.1:8787/v1/responses
```

`/health` reports protocol and circuit state without URLs or credentials. Structured logs contain request ID, provider/model IDs, status, latency, and usage when available; request bodies and keys are not logged at normal log levels.

## Codex

Add the settings from `codex-config.example.toml` to the Codex configuration and choose a public model. The local gateway currently has no client authentication unless `PROXY_API_KEY` or an `access` policy is configured:

```powershell
codex -m "faker/kimi-for-coding"
codex -m "sub2api/gpt-codex"
codex -m "local/gemma"
codex -m "vllm/gemma-4-31b-it-uncensored-bf16"
```

Do not set `requires_openai_auth = true` for this gateway.

Generate the private model catalog after changing `gateway.config.json`:

```powershell
npm run catalog
```

Set `model_catalog_json` in the user-level Codex `config.toml` to the generated absolute path. Restart Codex after changing the catalog; `/model` will then list every registered gateway model.

## Current protocol scope

Native Responses requests, errors, and SSE bytes are forwarded without conversion except for the upstream model ID. Chat Completions and Anthropic Messages both support text, function tools, tool results, parallel-tool flags, non-streaming output, and SSE conversion. Anthropic providers use `/messages`, `x-api-key`, and the configured `anthropic-version`; OpenAI-compatible providers use bearer authentication. When the desktop provider editor uses Auto detect, every discovered model receives its own protocol candidates. The gateway selects them independently on first use and only retries another protocol when the upstream explicitly reports an unsupported route. Explicit protocol selection still applies one protocol to the whole Provider.

For converted Chat Completions and Anthropic Messages routes, Codex namespace tools (MCP and multi-agent groups) and hosted web search are not sent upstream because those APIs cannot represent the complete Responses payload. Core function-based shell and file tools remain available. Native Responses routes keep the complete tool payload.
