# Windows and macOS Desktop Release

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

The MinIO release layout and complete operator workflow are documented in
[`docs/update-system.md`](./update-system.md). Desktop builds read the shared public manifest
at `https://minio.gshbzw.com/wxfile/rhzycode/version.json`, then use the Windows feed under
the same prefix.

Production releases should use an Authenticode-signed build:

```powershell
$env:CSC_LINK = "C:\secure\rhzycode-signing.pfx"
$env:CSC_KEY_PASSWORD = "<certificate-password>"
$env:RHZYCODE_UPDATE_URL = "https://minio.gshbzw.com/wxfile/rhzycode/windows"
$env:RHZYCODE_REQUIRE_SIGNING = "1"
npm run dist:desktop
```

electron-builder emits the channel metadata and SHA-512 package data used by
`electron-updater`. `RHZYCODE_REQUIRE_SIGNING=1` makes packaging fail when no signing
identity is available. The desktop Settings panel supports check, download, and
install/restart states.

## macOS

macOS packages must be produced on macOS so the bundled Codex binary, Electron runtime,
Keychain integration, Developer ID signature, and notarization all match the target host.

```bash
npm run pack:mac
npm run dist:mac
```

The release contains DMG and ZIP artifacts; the ZIP and `latest-mac.yml` are required by
the automatic update feed. Signing, notarization, architecture selection, MinIO staging,
and iOS delivery are documented in [`docs/apple-platforms.md`](./apple-platforms.md).
