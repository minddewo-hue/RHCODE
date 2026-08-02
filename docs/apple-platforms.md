# macOS 与 iOS 平台

当前仓库已有 Apple 平台适配和构建入口，但尚未完成正式签名、公证、App Store 上架和公网更新发布。

## 必要环境

- macOS 构建机和当前 Xcode。
- Apple Developer 账号与团队配置。
- Developer ID Application 身份（macOS）。
- App Store 分发证书、描述文件和 App Store Connect 记录（iOS）。
- 与目标 macOS 架构匹配、版本符合 `desktop/codex-version.json` 的 Codex CLI。

## macOS 桌面

平台适配包括：

- `macos` 主机标识和 Dock 生命周期。
- Electron `safeStorage` 的 Keychain 后端。
- 无扩展名的内置 `codex` 与可选 code-mode host。
- DMG/ZIP 产物和 `latest-mac.yml`。

构建：

```bash
npm install
npm run check
npm run pack:mac
npm run dist:mac
```

当前脚本默认使用构建机架构。需要 x64/arm64 双架构时分别提供相应 Codex 原生二进制；不能只合并 Electron ASAR 来生成 universal 包。

签名和公证：

```bash
export CSC_LINK=/secure/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD='...'
export APPLE_API_KEY=/secure/AuthKey.p8
export APPLE_API_KEY_ID='...'
export APPLE_API_ISSUER='...'
export RHZYCODE_REQUIRE_SIGNING=1
npm run dist:mac
```

发布前验证 `codesign`、notarization、stapler 和 Gatekeeper，并在全新用户环境测试安装与自动更新。

## iOS 移动端

Expo 配置位于 `mobile/app.json`。KEY 由 SecureStore 的 Keychain 后端保存；移动业务连接仍只经过中转服务。

开发：

```bash
npm install
npm run dev:ios
```

Archive 和 IPA：

```bash
export RHZYCODE_IOS_EXPORT_OPTIONS_PLIST=/secure/ExportOptions.plist
export RHZYCODE_IOS_SCHEME=RHZYCODE
npm run update:build:ios
```

脚本执行 Expo prebuild、Xcode archive 和 export，产物写入 `mobile/release-ios/`。签名团队和导出方式由 Xcode 与 export options 决定，不写入仓库。

## 当前发布限制

`appupdate/scripts/publish.mjs` 当前只接受 `windows` 和 `android`。虽然 update contract 可以继续扩展，Apple 平台尚未接入当前公网 `version.json` 和中转静态文件路由。

正式支持前需要：

1. 扩展更新清单 schema 与 publisher。
2. 增加 macOS ZIP/metadata 上传和中转 feed。
3. 配置 iOS App Store URL 与 build number 比较。
4. 增加客户端、发布器和中转测试。
5. 在真实签名设备验证升级和凭据保留。

## 上线门禁

- [ ] macOS x64/arm64 冷启动、Dock、窗口、终端和附件。
- [ ] Keychain 锁定/拒绝与加密状态恢复。
- [ ] Developer ID、notarization、stapler 和 Gatekeeper。
- [ ] macOS 自动更新 feed、下载、重启和回滚。
- [ ] iPhone/iPad 的相机、相册、文件、前后台和弱网恢复。
- [ ] TestFlight 安装、覆盖升级和 Keychain 数据保留。
- [ ] App Store 跳转、版本/build number 和公开 URL。

Windows 环境只能验证共享 TypeScript、测试和脚本语法，不能替代上述 Apple 真机与签名门禁。
