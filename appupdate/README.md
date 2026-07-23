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

Publishing credentials are read only from these environment variables:

```powershell
$env:RHZYCODE_MINIO_ACCESS_KEY = "<access-key>"
$env:RHZYCODE_MINIO_SECRET_KEY = "<secret-key>"
npm run update:publish
```

Do not commit credentials. Endpoint, bucket, region, prefix, and credential
variable names are configured in `appupdate/config.json`.

`npm run update:serve` is only a migration bridge for already-installed builds
that still use `http://192.168.11.103:8791`. New builds access MinIO directly.

See [`docs/update-system.md`](../docs/update-system.md) for the full release flow.
Apple build and signing details are in [`docs/apple-platforms.md`](../docs/apple-platforms.md).
