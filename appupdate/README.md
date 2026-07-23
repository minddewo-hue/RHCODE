# RHZYCODE MinIO updates

Release files are published under the public MinIO prefix `wxfile/rhzycode/`.
Windows, macOS, Android, and iOS read the same version manifest:

`https://minio.gshbzw.com/wxfile/rhzycode/version.json`

## Commands

```powershell
npm run update:build:desktop
npm run update:build:mobile
# Run these on macOS when producing Apple artifacts:
npm run update:build:mac
npm run update:build:ios
npm run update:stage
npm run update:publish
```

`update:stage` creates the local mirror in `appupdate/rhzycode/` without making
network changes. `update:publish` uploads configured platform packages and desktop
updater metadata, then replaces `version.json` last. Apple entries are optional until
their artifacts and App Store URL are supplied; see the platform guide.

On Windows, save credentials once in the local DPAPI-protected credential store:

```powershell
npm run update:credentials
```

Existing Python MinIO settings can be imported without printing either key:

```powershell
npm run update:credentials -- -ImportPythonFile "D:\path\to\test_minio_file.py"
```

The encrypted record is stored in `appupdate/.minio-credentials.json`, is ignored
by Git, and can only be decrypted by the same Windows user. `update:publish`
loads it automatically. Run the configuration command again after changing user
accounts or machines.

Environment variables remain available as a temporary override and take priority
over the saved record:

```powershell
$env:RHZYCODE_MINIO_ACCESS_KEY = "<access-key>"
$env:RHZYCODE_MINIO_SECRET_KEY = "<secret-key>"
npm run update:publish
```

Do not commit credentials or the source file containing plaintext keys. Endpoint,
bucket, region, prefix, and credential settings are configured in
`appupdate/config.json`. On macOS and Linux, use environment variables because
the persistent store currently relies on Windows DPAPI.

`npm run update:serve` is only a migration bridge for already-installed builds
that still use `http://192.168.11.103:8791`. New builds access MinIO directly.

See [`docs/update-system.md`](../docs/update-system.md) for the full release flow.
Apple build and signing details are in [`docs/apple-platforms.md`](../docs/apple-platforms.md).
