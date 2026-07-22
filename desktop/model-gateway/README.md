# Model Gateway

This directory contains the gateway implementation and its tests. Runtime data is kept at the desktop application root:

- `desktop/gateway.config.json` contains provider and model routing metadata.
- `desktop/codex-model-catalog.json` contains the bundled Codex model catalog.
- `desktop/.env` contains local development credentials and is never committed.

The desktop application embeds `src/embedded.js`. `server.js` is retained as a standalone integration-test entry point and accepts an absolute `GATEWAY_CONFIG` path.

Run the gateway tests from the repository root:

```powershell
npm run gateway:test
```

Regenerate the model catalog after changing the gateway configuration:

```powershell
npm run gateway:catalog
```

Provider keys must be supplied through environment variables named by `api_key_env`; never add API keys to `gateway.config.json`.
