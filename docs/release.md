# Windows Release

## Build

The release pins Electron `43.1.1` and Codex CLI `0.145.0`.

```powershell
npm run pack:desktop
npm run dist:desktop
```

Artifacts are written to `desktop/release`. The packaging script rejects a mismatched Codex CLI and excludes `.env`, `auth.json`, and `config.toml` from `app.asar`.

Packaging uses the pinned installed Electron distribution from `node_modules/electron/dist` and verifies the executable reports the expected version before building. `RHZYCODE_ELECTRON_DIST` may select another preinstalled distribution for CI, but the same version check still applies; normal development packaging does not require downloading Electron again.

Every package run audits `app.asar` and `resources` for credential, state, certificate, and private-key files. It writes `desktop/release/release-manifest.json` with the product versions, artifact sizes, SHA-256 hashes, Authenticode status, and update-channel state. Re-audit an existing release with:

```powershell
npm run audit:release --workspace @rhzycode/desktop
```

## Provider credentials

Installed builds store Provider API keys in `%APPDATA%\@rhzycode\desktop\gateway-credentials.json`. Values are encrypted with Electron `safeStorage` and Windows DPAPI. The renderer receives only configured/source status and never receives stored plaintext values. At least one Provider key is required; Providers without a key and their exclusive models remain disabled.

Source development also loads keys from `desktop/.env`; an external gateway directory may be selected with `RHZYCODE_GATEWAY_HOME`. Installed builds use the secure store, whose values take precedence over environment-loaded keys. The release never packages `.env`.

Development and automated tests may isolate all Electron application data with `RHZYCODE_USER_DATA_DIR`. Agent Host data remains in the application-owned `codex-home` below that directory unless `RHZYCODE_CODEX_HOME` explicitly selects another isolated location. Do not point either variable at the user's default `.codex` directory.

## Code signing

Set the standard electron-builder signing variables before producing a trusted release:

```powershell
$env:CSC_LINK = "C:\secure\rhzycode-signing.pfx"
$env:CSC_KEY_PASSWORD = "<certificate-password>"
$env:RHZYCODE_REQUIRE_SIGNING = "1"
npm run dist:desktop
```

`CSC_LINK` may also use an electron-builder-supported certificate URL or encoded value. Never commit the certificate or its password. With `RHZYCODE_REQUIRE_SIGNING=1`, packaging fails if no signing identity is configured.

## Automatic updates

The trusted-LAN development channel and its complete operator workflow are documented in
[`docs/update-system.md`](./update-system.md). It uses the fixed private endpoint
`http://192.168.11.103:8791`, and the local packaging exception accepts only localhost or
RFC1918 private addresses when `RHZYCODE_ALLOW_UNSIGNED_LOCAL_UPDATES=1` is explicitly set.

Public or production update channels still require a signed build and HTTPS:

```powershell
$env:CSC_LINK = "C:\secure\rhzycode-signing.pfx"
$env:CSC_KEY_PASSWORD = "<certificate-password>"
$env:RHZYCODE_UPDATE_URL = "https://updates.example.com/rhzycode/windows"
$env:RHZYCODE_REQUIRE_SIGNING = "1"
npm run dist:desktop
```

electron-builder emits the channel metadata and SHA-512 package data used by `electron-updater`. Packaging rejects unsigned non-private update channels. The desktop Settings panel supports check, download, and install/restart states.

The local release build writes its generic provider URL to the packaged `app-update.yml`.
Keep public builds pinned to their signed HTTPS channel and do not use the private-network
unsigned exception for an internet-reachable endpoint.
