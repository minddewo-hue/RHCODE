# RHZYCODE Local Update Service

The complete Chinese build, publishing, validation, security, and troubleshooting
guide is in [`docs/update-system.md`](../docs/update-system.md).

The service listens on `0.0.0.0:8791` and advertises
`http://192.168.11.103:8791` to desktop and Android clients.

## Commands

```powershell
npm run update:build:desktop
npm run update:build:mobile
npm run update:publish
npm run update:serve
```

`npm run update:release` runs both builds and publishes the resulting channel.
Increment the desktop and mobile versions before publishing a new release. Android
also requires an incremented `expo.android.versionCode`.

Start the update service manually when the machine is serving releases:

```powershell
npm run update:serve
```

Desktop checks once after launch, then every two hours while local time is between
10:00 and 20:00. Android checks once shortly after each cold launch. Both clients
also retain their manual check action.

Health and update metadata are available at:

- `http://192.168.11.103:8791/health`
- `http://192.168.11.103:8791/manifest.json`
- `http://192.168.11.103:8791/desktop/latest.yml`
