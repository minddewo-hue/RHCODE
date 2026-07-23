# RHZYCODE Architecture

## System boundaries

```text
Desktop UI -> Desktop Agent Host -> Codex App Server -> Transfer Gateway -> LLM providers
Mobile UI  -> Control Plane       -> Desktop Agent Host or isolated cloud worker
```

The model gateway is an inference boundary. It does not own task execution, repository access, approvals, or durable thread state.

The Agent Host owns local process lifecycle and converts version-specific App Server JSON-RPC messages into the stable RHZYCODE protocol. The desktop renderer and mobile client consume only RHZYCODE domain events.

## Transport rules

- Use JSONL over stdio between a desktop Agent Host and Codex App Server.
- Use authenticated HTTP/WS only on a trusted private LAN; use HTTPS/WSS for managed or remotely reachable deployments.
- Do not expose the App Server WebSocket listener directly to a public network.
- Persist events with monotonic sequence numbers so reconnecting clients can replay missed activity.
- Keep provider credentials on the Agent Host, gateway, or encrypted worker secret store. Never send them to a mobile client.
- Encrypt desktop control snapshots, the persistent mobile access key, and audit records with Electron `safeStorage`; Windows uses DPAPI and macOS uses the system Keychain backend.
- Authenticate mobile HTTP requests with the desktop key as a bearer token and WebSocket sessions with a dedicated subprotocol.

## Platform boundaries

- `desktop/src/main/platform` maps Node/Electron platform details into RHZYCODE domain names and native lifecycle behavior.
- `mobile/src/platform` owns Android/iOS behavior that cannot be expressed by the shared React Native layer.
- `packages/protocol` is the control-plane contract; `packages/update-contract` is the release-manifest contract.
- Platform-specific installers and signing tools remain outside the shared runtime. Unsupported native modules must not fail during application module loading.
- Apple artifacts are built only on macOS. Cross-platform unit tests validate contracts on any host, but do not replace signed-device verification.

## Delivery phases

### Phase 1: Desktop local mode

- Project and thread navigation
- App Server lifecycle and model discovery
- Streaming turns and activity timeline
- Command approvals, diffs, interruption, and retry
- Transfer gateway health and model selection

### Phase 2: Remote control

- Persistent desktop-generated mobile access key
- Outbound host connection to the control plane
- Durable event replay and presence
- Mobile task creation, steering, approval, and notifications

Persistent-key authentication, encrypted persistence, LAN transport, and optional certificate-driven HTTPS/WSS termination are implemented. A remote deployment still requires a trusted certificate, reachable endpoint, and network policy; an outbound relay remains a future topology option.

### Phase 3: Cloud workers

- Isolated repository workers
- Durable queues and resumable tasks
- Encrypted credentials and artifact storage
- Team policy, audit, quotas, and billing

## Versioning

Pin the Codex binary used by each desktop release. Generate TypeScript or JSON Schema bindings from that exact App Server version, then translate them in the Agent Host. Experimental App Server methods must not enter the public RHZYCODE protocol without a compatibility layer.
