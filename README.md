# RHZYCODE

RHZYCODE is a cross-platform coding agent built around a local or remote Agent Host and a multi-model inference gateway.

## Workspace

```text
desktop/                 Electron desktop client and local Agent Host adapter
mobile/                  Expo mobile remote-control client
packages/protocol/       Stable RHZYCODE domain protocol and validation schemas
services/control-plane/  Device, task, event, and WebSocket control service
transfer/                Existing OpenAI-compatible multi-model gateway
docs/                    Architecture and delivery notes
```

## Development

Requirements: Node.js 20 or newer and npm 11 or newer.

```powershell
npm install
npm run dev:desktop
npm run dev:mobile
```

The desktop client starts its gateway and control plane automatically, then talks to `codex app-server` through local JSONL over stdio. Set `RHZYCODE_CODEX_PATH` when `codex` is not available on `PATH`.

RHZYCODE keeps its Agent Host state in an application-owned `codex-home` directory, separate from the user's default Codex configuration. Set `RHZYCODE_CODEX_HOME` only when a development or deployment environment needs a different isolated location.

The desktop control plane listens on `0.0.0.0:8790` by default and advertises a physical LAN IPv4 address in Settings. Mobile connects with that IP, the editable desktop port, and the persistent desktop-generated access key. The saved port persists across restarts; `RHZYCODE_SYNC_HOST` and `RHZYCODE_SYNC_PORT` provide initial deployment defaults. Trusted HTTPS/WSS certificates remain supported for managed deployments.

Build the Windows installer with `npm run dist:desktop`; artifacts are written to `desktop/release`. The release bundles the pinned Codex CLI but never packages `transfer/.env`, Codex authentication, or provider keys. Configure Provider keys from the desktop Settings panel or use `RHZYCODE_GATEWAY_HOME` for an external gateway directory.

See [docs/architecture.md](docs/architecture.md) for system boundaries and [docs/roadmap.md](docs/roadmap.md) for implementation status and next milestones.

See [docs/release.md](docs/release.md) for Provider credential storage, pinned binaries, and Windows code-signing configuration.

See [docs/mobile-connection.md](docs/mobile-connection.md) for the persistent access-key contract, storage, rotation, and LAN/TLS boundaries.

## Parallel development

Use [docs/parallel-development.md](docs/parallel-development.md) before running separate desktop and mobile development tasks in parallel. The task-specific handbooks are:

- [docs/desktop-development.md](docs/desktop-development.md)
- [docs/mobile-development.md](docs/mobile-development.md)
