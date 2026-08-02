# RHZYCODE 发布流程

本文档说明产物构建和签名。安装包暂存、远程上传和客户端更新行为见 [更新系统](update-system.md)。

## 版本来源

发布前同步递增：

| 平台 | 文件 |
| --- | --- |
| Windows/macOS 桌面版本 | `desktop/package.json`、根 `package-lock.json` |
| Android/iOS 可见版本 | `mobile/package.json`、`mobile/app.json`、根 `package-lock.json` |
| Android 内部版本 | `mobile/app.json` 的 `android.versionCode` |
| Android 生成工程 | `mobile/android/app/build.gradle`，通常由 Expo prebuild 同步 |
| iOS 内部版本 | `mobile/app.json` 的 `ios.buildNumber` |
| 内置 Codex CLI | `desktop/codex-version.json` |

公开已发布版本以 `/v1/updates/manifest` 为准，不以本地 package 版本推断。

## 发布前检查

```powershell
npm install
npm run check
npm run build
```

还要确认：

- `git diff` 中没有 `.env`、KEY、证书、私钥或用户状态。
- 实际 Codex 二进制 `--version` 与锁定文件一致。
- Provider 配置没有内联 `api_key`。
- 目标平台签名身份和密码从安全环境注入。
- 更新 origin 与 `appupdate/config.json` 一致。

## Windows

解包目录：

```powershell
npm run pack:desktop
```

NSIS x64 安装包：

```powershell
npm run dist:desktop
```

产物位于 `desktop/release/`：

```text
RHZYCODE-Setup-<version>-x64.exe
RHZYCODE-Setup-<version>-x64.exe.blockmap
latest.yml
release-manifest.json
win-unpacked/
```

打包脚本会：

- 校验 Electron 和 Codex 版本。
- 生成平台图标并嵌入 Codex、模型目录和网关配置。
- 排除 `.env`、`auth.json` 和 `config.toml`。
- 扫描 ASAR/resources 中的凭据、状态、证书和私钥。
- 写入文件大小、SHA-256、Authenticode 和更新通道审计。

复核已有产物：

```powershell
npm run audit:release --workspace @rhzycode/desktop
```

### Windows 签名

```powershell
$env:CSC_LINK = "C:\secure\rhzycode-signing.pfx"
$env:CSC_KEY_PASSWORD = "<从安全环境注入>"
$env:RHZYCODE_REQUIRE_SIGNING = "1"
npm run dist:desktop
```

`RHZYCODE_REQUIRE_SIGNING=1` 且没有签名身份时构建必须失败。正式发布必须检查 `release-manifest.json` 中安装包和可执行文件的 Authenticode 状态。

## Android

```powershell
npm run update:build:mobile
```

脚本执行 Expo Android prebuild 和 Gradle `assembleRelease`，并注入公开中转 origin。产物：

```text
mobile/android/app/build/outputs/apk/release/app-release.apk
```

正式分发前必须用生产 keystore 配置 release signing。仓库当前 Gradle 模板仍使用开发签名，适合内部安装，不满足公开商店或受信任生产分发要求。

真机检查：

- 全新安装和覆盖升级。
- SecureStore 数据保留。
- 相机、相册、文件和 APK 安装权限。
- 浅色/夜间模式及小屏布局。
- 更新下载后的大小、SHA-256 和安装器跳转。

## Windows + Android 完整构建

```powershell
npm run update:release
```

该命令依次构建 Windows、Android，并执行本地 `update:publish`。它不会上传远程服务器；上传必须另行执行：

```powershell
npm run update:deploy
```

## macOS

macOS 只能在 macOS 主机打包：

```bash
npm run pack:mac
npm run dist:mac
```

需要与目标架构一致的 Codex 原生二进制。DMG 用于安装，ZIP 与 `latest-mac.yml` 用于自动更新。签名、公证和架构门禁见 [Apple 平台](apple-platforms.md)。

## iOS

iOS 只能在 macOS/Xcode 环境构建：

```bash
export RHZYCODE_IOS_EXPORT_OPTIONS_PLIST=/secure/ExportOptions.plist
npm run update:build:ios
```

脚本生成 Xcode archive 并导出 IPA。当前更新发布器尚未把 macOS/iOS 写入公网统一清单；正式支持 Apple 更新前，需要扩展 `packages/update-contract`、`appupdate/scripts/publish.mjs`、中转文件路由和客户端测试。

## 凭据和用户数据

- 源码开发可从 `desktop/.env` 读取 Provider Key，但该文件绝不进入发行包。
- 安装版 Provider Key 由 Electron `safeStorage` 加密。
- `RHZYCODE_USER_DATA_DIR` 和 `RHZYCODE_CODEX_HOME` 仅用于隔离开发/测试。
- 不要把任何测试目录指向用户默认 `.codex`。
- 签名密码、keystore、PFX、Apple API key 和 export plist 不提交仓库。

## 发布验收

- [ ] 版本和 build number 已递增且各文件一致。
- [ ] 全仓检查通过。
- [ ] 目标平台产物构建成功。
- [ ] Codex 版本与锁定文件一致。
- [ ] 发布审计无敏感文件命中。
- [ ] 生产发布使用正式签名。
- [ ] 安装、启动、更新、回滚和卸载已验证。
- [ ] 远程部署后公网清单、文件长度和 SHA-256 一致。
