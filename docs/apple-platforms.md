# macOS 与 iOS 准备说明

当前仓库已具备 Apple 平台的代码边界、构建入口和更新清单模型。正式交付仍需要一台 macOS 构建机、Apple Developer 账号、签名身份、公证凭据和 App Store Connect 配置。

## macOS 桌面端

Electron 主机在 macOS 上使用：

- `macos` 主机平台标识；
- Electron `safeStorage` 对接系统钥匙串；
- 无扩展名的内置 `codex` 可执行文件；
- macOS 的保留 Dock 生命周期；
- `platforms.macos` 更新清单和 `latest-mac.yml` feed；
- DMG 与 ZIP 发布产物，ZIP 用于 `electron-updater`。

在 Mac 上安装与当前架构一致、版本符合 `desktop/codex-version.json` 的 Codex CLI，然后执行：

```bash
npm install
npm run check
npm run pack:mac
npm run dist:mac
```

可用 `--arch=x64` 或 `--arch=arm64` 直接调用打包脚本选择架构。当前默认跟随构建机架构；若需要 universal 包，必须先解决两种 Codex 原生二进制的资源布局，不能只合并 Electron ASAR。

正式发布前配置 Developer ID Application 签名和 Apple 公证变量，并启用强制门禁：

```bash
export CSC_LINK=/secure/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD='...'
export APPLE_API_KEY=/secure/AuthKey.p8
export APPLE_API_KEY_ID='...'
export APPLE_API_ISSUER='...'
export RHZYCODE_REQUIRE_SIGNING=1
npm run dist:mac
```

## iOS 移动端

Expo 配置已包含 Bundle ID、build number、本地网络用途说明、局域网传输例外和出口加密声明。移动端连接与 Android 使用同一 RHZYCODE HTTP/WebSocket 协议，KEY 存入 iOS Keychain 后端的 SecureStore。

开发运行：

```bash
npm install
npm run dev:ios
```

生成 App Store IPA 时，准备 Xcode export options plist，并执行：

```bash
export RHZYCODE_IOS_EXPORT_OPTIONS_PLIST=/secure/ExportOptions.plist
npm run update:build:ios
```

脚本执行 Expo iOS prebuild、Xcode archive 和 export。签名团队、描述文件和导出方式由 Xcode 工程环境及 export options 决定，不写入仓库。

## 发布清单

macOS 发布时向发布器提供：

```bash
export RHZYCODE_MAC_DMG=/artifacts/RHZYCODE-0.1.8-arm64.dmg
export RHZYCODE_MAC_ZIP=/artifacts/RHZYCODE-0.1.8-arm64-mac.zip
export RHZYCODE_MAC_METADATA=/artifacts/latest-mac.yml
export RHZYCODE_MAC_ARCH=arm64
```

iOS 完成 App Store Connect 上架并获得公开地址后提供：

```bash
export RHZYCODE_IOS_STORE_URL=https://apps.apple.com/app/id0000000000
```

再执行 `npm run update:stage` 检查四平台清单，确认后运行 `npm run update:publish`。iOS 客户端发现新版本后打开 App Store，不下载或侧载 IPA。

## 上线门禁

- macOS x64/arm64 冷启动、窗口关闭/重新激活、终端、附件和目录权限验证。
- macOS 钥匙串拒绝/锁定场景以及历史加密状态恢复验证。
- Developer ID 签名、notarization、Gatekeeper 和自动更新验证。
- iPhone/iPad 真机本地网络权限、相机、相册、文件选择和后台重连验证。
- App Store TestFlight 安装、升级、Keychain 数据保留和商店跳转验证。
- 四平台清单的 URL、版本/build number、文件大小和校验值验证。

Apple 签名、公证、TestFlight 和 App Review 尚未在当前 Windows 工作区执行，这些属于正式发布前的外部基础设施门禁。
