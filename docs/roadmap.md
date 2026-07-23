# RHZYCODE Delivery Roadmap

Updated: 2026-07-23

## Verified baseline

| Capability | Status | Verification |
| --- | --- | --- |
| Isolated desktop Agent Host | Complete | Application-owned `CODEX_HOME`; default Codex config hashes unchanged |
| Embedded multi-model gateway | Complete | 23 models across Faker and Sub2API; gateway integration suite |
| Model discovery and per-turn switching | Complete | All 23 models are selectable; `turn/start.model` changes the model on an existing thread |
| Streaming text turns | Complete | Live vLLM turn returned `RHZYCODE_SMOKE_OK` |
| Turn interruption | Complete | Live turn reached `interrupted` through `threadId + turnId` |
| Command execution activity | Complete | Safe PowerShell command and output persisted to the timeline |
| Command and file approvals | Complete | App Server response mapping, desktop controls, and control-plane test |
| Thread history and resume | Complete | `thread/list` and `thread/resume` restored cwd, model, and messages |
| Workspace selection persistence | Complete | Desktop restores the last project and last selected thread per project on startup |
| Concurrent desktop turns | Complete | Different threads run concurrently while project, thread, terminal, and model navigation remain available |
| Failure retry control | Complete | Deterministic 401, 429, timeout, interrupted SSE, retrying, and terminal-failure coverage |
| Structured user input | Complete | Typed option/secret controls; answers excluded from event history |
| Additional permission requests | Complete | Requested grants are turn-scoped; decline grants an empty profile |
| Interactive terminal | Complete | App Server PTY, stdin, resize, ANSI rendering, buffered restore, and terminate smoke |
| Approval policy control | Complete | Persisted `on-request`, `untrusted`, or `never` override on threads and turns |
| Sandbox policy control | Complete, upstream limitation | Policies map correctly; Codex 0.145.0 Windows Code Mode may reject valid workspace writes |
| File and image attachments | Complete | Native App Server local-image input plus absolute-path file references; 20-item limit |
| Thread search and archive | Complete | Server-side title search, archived listing, archive, restore, and cross-client removal events |
| Provider active health | Complete | Startup, 60-second, and manual probes with latency, circuit state, HTTP status, and sanitized errors |
| Windows desktop distribution | Complete | NSIS and unpacked builds; Electron 43.1.1 and bundled Codex CLI 0.145.0 pinned |
| Provider credential storage | Complete | Electron `safeStorage` uses the OS secure-storage backend; stored plaintext is never returned to the renderer |
| Thread lifecycle management | Complete | Search, rename, archive, restore, permanent delete, and recent-project persistence |
| Encrypted control persistence | Complete | `safeStorage`-encrypted snapshots and 2,000-event replay; pending requests are not revived |
| Persistent mobile access | Complete | Desktop-generated KEY, encrypted persistence, audit, and immediate rotation |
| Authenticated control API | Complete | Bearer HTTP and WebSocket subprotocol authentication |
| Desktop-authoritative mobile commands | Complete | Safe thread/Turn control, structured answers, lifecycle operations, idempotency, and non-secret audit |
| LAN control transport | Complete | Private-LAN HTTP/WS plus optional certificate-driven HTTPS/WSS |
| Automatic update client | Complete, channel pending | Check/download/install states; signed update URL is required during packaging |
| Cross-platform update contract | Complete | Shared Windows/macOS/Android/iOS manifest parser and client tests |
| macOS code preparation | Complete, release pending | Platform host mapping, Keychain-compatible safeStorage, DMG/ZIP build and update feed entry |
| iOS code preparation | Complete, release pending | Expo configuration, safe native-module loading, App Store update flow and Xcode archive entry |

## Accepted risks

- The 11 moderate `npm audit` findings currently come from the Expo 57 build toolchain and its Xcode parser dependency. There are no high or critical findings after applying the compatible `fast-uri` patches. Forced automated remediation proposes incompatible Expo/Expo Sharing downgrades, so the project accepts the remaining findings temporarily and will update when Expo publishes compatible dependency fixes.
- Codex CLI 0.145.0 on Windows may reject valid `workspace-write` Code Mode file operations as outside the project even when the desktop sends the correct cwd and writable root. RHZYCODE does not silently escalate permissions; explicit Full access is the temporary local-only workaround. Re-run `validation/workspace-write-smoke` after upgrading Codex.

## Phase 1 remaining

1. Obtain a trusted Windows code-signing certificate and run the implemented required-signing release path.
2. Provision a signed update endpoint and publish generated release-channel metadata.
3. Provision a trusted control-plane certificate, reachable host, and firewall policy for physical mobile devices, or deploy an outbound relay.

## Apple platform release gates

1. Provision a macOS CI/build host with x64 and arm64 Codex binaries as required.
2. Configure Developer ID signing, notarization, Gatekeeper verification, and a public macOS update feed.
3. Configure the Apple Developer team, provisioning profiles, App Store Connect record, TestFlight, and public App Store URL.
4. Run macOS and iOS device-level smoke tests listed in `docs/apple-platforms.md`.

## Phase 2 gate

Remote-control software gates are complete; deployment still requires trusted transport infrastructure:

1. Persistent desktop-generated mobile KEY. Complete.
2. Authenticated HTTPS/WSS transport. Complete; trusted certificate deployment remains.
3. Durable event storage and reconnect replay. Complete.
4. Mobile approval and command audit records. Complete.
5. Secret rotation. KEY replacement and active WebSocket closure are complete.

## Verification commands

```powershell
npm run check
npm run build
npm run smoke:agent --workspace @rhzycode/desktop
npm run smoke:agent --workspace @rhzycode/desktop -- --live
npm run smoke:agent --workspace @rhzycode/desktop -- --history
npm run smoke:agent --workspace @rhzycode/desktop -- --command
npm run smoke:agent --workspace @rhzycode/desktop -- --interrupt
npm run smoke:agent --workspace @rhzycode/desktop -- --terminal
npm run pack:desktop
npm run smoke:mobile-access --workspace @rhzycode/desktop
npm run dist:desktop
```
