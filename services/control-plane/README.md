# RHZYCODE Control Plane

This service provides the RHZYCODE snapshot, event replay, mobile access-key authentication, approval, command, and audit boundary.

```powershell
npm run dev:control
```

Endpoints:

```text
GET  /health
GET  /v1/snapshot
GET  /v1/events?after=0       WebSocket event stream
POST /v1/hosts
POST /v1/threads
POST /v1/events
POST /v1/approvals/:id
POST /v1/commands/threads/start
POST /v1/commands/threads/:threadId/turns/start
POST /v1/commands/threads/:threadId/turns/interrupt
GET  /v1/commands/threads/archived
POST /v1/commands/user-inputs/:requestId/submit
POST /v1/commands/threads/:threadId/rename
POST /v1/commands/threads/:threadId/archive
POST /v1/commands/threads/:threadId/unarchive
DELETE /v1/commands/threads/:threadId
```

`npm run dev:control` starts the standalone in-memory service without a `MobileAccessManager`; it is useful for protocol development but does not provide authenticated mobile access. The desktop application embeds the same service with:

- DPAPI-encrypted durable snapshots and event replay;
- a persistent DPAPI-encrypted desktop access key, command audit, and immediate key rotation;
- HTTP Bearer authentication and WebSocket subprotocol authentication;
- immediate closure of a revoked or rotated device's existing WebSocket sessions;
- optional certificate-driven HTTPS/WSS.

When mobile access is enabled, every route except `/health` and `OPTIONS` requires the persistent desktop key. Mobile clients cannot use the host publishing endpoints.

Every write command requires an `Idempotency-Key` header containing 8-200 letters, digits, `.`, `_`, `:`, or `-`; the read-only archived-thread query does not. Successful write results are replayed per client/key for ten minutes; reusing a key with a different request returns `409`. Remote requests accept only `read-only` or `workspace-write` sandbox modes and `on-request` or `untrusted` approval policies. Active threads cannot be archived or permanently deleted remotely. User-input answers are delivered only to the pending App Server RPC; the replay cache stores a request hash and non-secret response, while events and audit records contain only the request ID.

The desktop runtime executes every App Server command and remains the only writer of thread/timeline state; the control plane never fabricates state from an HTTP command. Archive and delete publish `thread.removed`; rename and unarchive publish authoritative `thread.updated` state. Permanent deletion is recorded in encrypted audit state.

The standalone development server has no mobile access manager or desktop command handlers, so remote commands are unavailable there. Use the embedded desktop control plane for end-to-end command testing.

The desktop runtime listens on all interfaces and advertises a preferred LAN IPv4 address by default. Plaintext HTTP/WS is intended only for a trusted private LAN; do not forward port `8790` or expose it publicly. External certificate and private-key files enable HTTPS/WSS for managed deployments.

See `docs/mobile-connection.md`, `docs/desktop-development.md`, and `docs/mobile-development.md` from the repository root for the complete security and client contracts.
