# RHZYCODE MinIO 升级系统

Windows、macOS、Android 和 iOS 共用 MinIO 版本清单，不再依赖开发电脑长期运行 HTTP 服务。iOS 安装包由 App Store 分发，清单只保存商店元数据。新版本客户端直接读取：

```text
https://minio.gshbzw.com/wxfile/rhzycode/version.json
```

## 目录结构

```text
wxfile/
  rhzycode/
    version.json
    windows/
      latest.yml
      RHZYCODE-Setup-<version>-x64.exe
      RHZYCODE-Setup-<version>-x64.exe.blockmap
    android/
      RHZYCODE-Android-<version>.apk
    macos/
      latest-mac.yml
      RHZYCODE-<version>-<arch>.dmg
      RHZYCODE-<version>-<arch>-mac.zip
```

本地 `appupdate/rhzycode/` 是同一结构的发布暂存目录。平台安装包目录被 Git 忽略，`version.json` 保留在仓库中作为清单示例和当前版本记录。

## 版本清单

清单使用平台映射。`platforms.windows`、`platforms.macos`、`platforms.android`、`platforms.ios` 由 `packages/update-contract` 统一校验；平台可以渐进发布，不要求四个平台同时存在。

```json
{
  "schemaVersion": 2,
  "publishedAt": "2026-07-23T00:00:00.000Z",
  "platforms": {
    "windows": {
      "version": "0.2.0",
      "architecture": "x64",
      "file": "windows/RHZYCODE-Setup-0.2.0-x64.exe",
      "downloadUrl": "https://minio.gshbzw.com/wxfile/rhzycode/windows/RHZYCODE-Setup-0.2.0-x64.exe",
      "feedUrl": "https://minio.gshbzw.com/wxfile/rhzycode/windows",
      "metadataUrl": "https://minio.gshbzw.com/wxfile/rhzycode/windows/latest.yml",
      "bytes": 123,
      "sha256": "<64位SHA-256>",
      "releaseNotes": "RHZYCODE Windows release"
    },
    "android": {
      "version": "0.2.0",
      "versionCode": 20,
      "file": "android/RHZYCODE-Android-0.2.0.apk",
      "downloadUrl": "https://minio.gshbzw.com/wxfile/rhzycode/android/RHZYCODE-Android-0.2.0.apk",
      "bytes": 123,
      "sha256": "<64位SHA-256>",
      "releaseNotes": "RHZYCODE Android release"
    }
  }
}
```

客户端请求清单时禁用缓存。Android 下载后校验字节数和 SHA-256；Windows/macOS 先比较统一清单中的版本，再通过各自 feed 的 electron-builder 元数据交给 `electron-updater`；iOS 比较版本和 build number 后打开 App Store URL。

## 发布配置

`appupdate/config.json` 只保存非敏感配置：MinIO endpoint、bucket、region、对象前缀以及密钥环境变量名称。Access Key 和 Secret Key 不得写入仓库。

当前 bucket 策略只为 `arn:aws:s3:::wxfile/rhzycode/*` 增加匿名 `s3:GetObject`，不开放 bucket 列表权限，也不影响其他前缀。发布脚本在上传完成后会以匿名请求复核清单和安装包；若公网策略失效，发布命令会明确失败。

发布前在当前 PowerShell 会话设置：

```powershell
$env:RHZYCODE_MINIO_ACCESS_KEY = "<access-key>"
$env:RHZYCODE_MINIO_SECRET_KEY = "<secret-key>"
```

## 发布流程

发布前递增以下版本：

1. `desktop/package.json` 的 `version`。
2. `mobile/package.json` 和 `mobile/app.json` 的版本。
3. `mobile/app.json` 的 `expo.android.versionCode`，该整数必须递增。
4. iOS 发布时递增 `mobile/app.json` 的 `expo.ios.buildNumber`。

完成两端构建并直接发布：

```powershell
Set-Location D:\work_space\RHZYCODE
npm run update:release
```

也可以分步执行：

```powershell
npm run update:build:desktop
npm run update:build:mobile
# 以下命令在 macOS 构建机执行
npm run update:build:mac
npm run update:build:ios
npm run update:stage
npm run update:publish
```

`update:stage` 只生成本地发布目录和清单，适合发布前检查。`update:publish` 先上传全部已配置平台的安装包、blockmap 和桌面更新元数据，最后才覆盖 `version.json`。因此客户端不会读到引用尚未上传文件的新清单。

原始构建产物位置：

```text
desktop/release/
mobile/android/app/build/outputs/apk/release/app-release.apk
mobile/release-ios/RHZYCODE-iOS-<version>.ipa
```

## 客户端检测

桌面端在启动约 10 秒后检查一次，运行期间每两小时在本地时间 10:00 至 20:00 之间检查。它按当前系统读取 `platforms.windows` 或 `platforms.macos`；版本更高时才访问对应 feed。

Android 冷启动约 3 秒后检查一次，设置页仍可手动检查。它读取 `platforms.android`，下载 `downloadUrl` 对应 APK，校验文件大小和 SHA-256 后调用系统安装器。

iOS 使用相同检查时机读取 `platforms.ios`。发现新版本后打开 `storeUrl`，不下载或侧载 IPA。

默认地址可在构建或调试时覆盖：

```powershell
$env:RHZYCODE_UPDATE_MANIFEST_URL = "https://example.test/version.json"
$env:EXPO_PUBLIC_UPDATE_URL = "https://example.test/version.json"
```

## 旧版本迁移

已经安装的旧桌面端和 Android 端仍访问 `http://192.168.11.103:8791`。在这些客户端完成一次过渡升级前，可临时运行：

```powershell
npm run update:serve
```

该兼容服务不保存安装包：它把旧版 `/manifest.json` 转换为旧结构，并把 `/desktop/*`、`/mobile/*` 重定向到 MinIO。所有活跃客户端升级到新检测逻辑后即可停止该服务。

## 发布验证

```powershell
npm test --workspace @rhzycode/appupdate
npm run typecheck --workspace @rhzycode/desktop
npm run typecheck --workspace @rhzycode/mobile
Invoke-RestMethod https://minio.gshbzw.com/wxfile/rhzycode/version.json
curl.exe -I https://minio.gshbzw.com/wxfile/rhzycode/windows/latest.yml
curl.exe -I https://minio.gshbzw.com/wxfile/rhzycode/android/RHZYCODE-Android-<version>.apk
```

至少确认清单版本、URL、文件大小和 SHA-256 与构建产物一致，安装包支持公网下载，Android 可覆盖安装，Windows/macOS 可完成下载和重启安装，iOS 商店链接可打开正确应用。

Windows 公网发布建议配置 Authenticode 证书，并使用 `RHZYCODE_REQUIRE_SIGNING=1` 强制缺少证书时构建失败。Android 必须持续使用同一 release keystore，否则无法覆盖安装且会丢失本机应用数据。
