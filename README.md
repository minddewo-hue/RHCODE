# RHZYCODE

RHZYCODE 是一个跨平台编程助手。桌面应用负责运行 Codex、访问本地项目和保存任务状态；移动应用通过中转服务远程查看和控制桌面任务。

当前可交付平台为 Windows 和 Android。macOS 与 iOS 已有构建入口，但正式分发仍需要 Apple 签名、公证和 App Store 配置。

## 核心能力

- 多模型编程对话、推理强度、审批策略和沙箱策略选择。
- 项目与对话管理：搜索、恢复、重命名、归档、删除和并发任务。
- 流式回复、Activity 时间线、命令执行、文件修改、审批和结构化输入。
- 图片与文件附件、生成图片预览和受控下载。
- 桌面内置终端、Provider 状态与安全凭据管理。
- 多台电脑移动控制、断线恢复、事件回放和长期访问 KEY。
- Windows 自动更新和 Android APK 更新。
- 浅色/夜间主题及桌面、手机响应式界面。

## 运行架构

```text
Mobile (Android / iOS)
    | HTTP/WS + desktop KEY
    v
Transfer Server
    | live relay, no KEY or task persistence
    v
Desktop Relay Client
    | loopback HTTP/WS
    v
Desktop Control Plane
    |-- Desktop Renderer through preload IPC
    |-- Agent Host -> Codex App Server
    |-- Model Gateway -> configured providers
    `-- encrypted local state and credentials
```

桌面是任务、项目和历史记录的权威节点。手机不直接连接 Provider、不持有 Provider API Key，也不直接访问桌面局域网端口。详细边界见 [系统架构](docs/architecture.md) 和 [移动连接](docs/mobile-connection.md)。

## 仓库结构

```text
desktop/                    Electron 桌面应用、Agent Host、控制面和模型网关
mobile/                     Expo / React Native 移动应用
transferserver/             桌面与手机之间的无状态中转及更新文件服务
packages/protocol/          桌面与移动共享的控制协议
packages/update-contract/   客户端与发布器共享的更新清单协议
appupdate/                  Windows、Android 和 Apple 平台构建/发布脚本
docs/                       架构、开发、发布和运维文档
validation/                 独立验证样例和历史验证产物
```

版本事实来源：桌面版本见 `desktop/package.json`，移动版本和 Android `versionCode` 见 `mobile/app.json`，内置 Codex 版本见 `desktop/codex-version.json`，公网已发布版本见更新清单 `/v1/updates/manifest`。不要在其他文档重复维护版本号。

## 开发环境

- Node.js 20 或更高版本。
- npm 11；仓库声明 `npm@11.6.2`。
- Windows 桌面构建需要 PowerShell。
- Android 构建需要 Android Studio、JDK 和 Android SDK。
- macOS/iOS 构建需要 macOS、Xcode 和对应签名身份。
- 桌面打包需要与 `desktop/codex-version.json` 完全一致的 Codex CLI。

安装并验证：

```powershell
npm install
npm run check
```

启动桌面应用：

```powershell
npm run dev:desktop
```

启动移动应用：

```powershell
npm run dev:mobile
```

连接 Android 真机时只需要反向代理 Metro 端口；业务连接仍经过中转服务：

```powershell
adb reverse tcp:8081 tcp:8081
npm run android --workspace @rhzycode/mobile
```

## 配置

模型路由位于 `desktop/gateway.config.json`。配置只保存 Provider 地址、模型映射和 API Key 环境变量名，不保存密钥值。

- 源码开发可从 `desktop/.env` 或进程环境读取 Provider Key。
- 安装版在桌面设置中保存 Provider Key，并由 Electron `safeStorage` 加密。
- 桌面使用 `RHZYCODE_TRANSFER_SERVER_URL` 指定中转 origin。
- 移动构建使用 `EXPO_PUBLIC_TRANSFER_SERVER_URL` 指定相同 origin。
- 两个变量只能包含服务地址，不能包含 KEY 或其他秘密。

当前默认中转地址为 `http://218.201.210.211:8000`。该部署使用 HTTP/WS，不提供传输加密；中转虽然不持久化 KEY 和任务数据，但生产环境仍应迁移到可信 HTTPS/WSS。

## 构建与发布

Windows 安装包：

```powershell
npm run dist:desktop
```

Android APK：

```powershell
npm run update:build:mobile
```

Windows 与 Android 完整发布：

```powershell
npm run update:release
npm run update:deploy
```

发布前必须先递增桌面/移动版本以及 Android `versionCode`。完整流程、产物、签名要求和公网验证见 [发布流程](docs/release.md) 与 [更新系统](docs/update-system.md)。

## 验证

```powershell
npm run check
npm run build
npm run test:ui --workspace @rhzycode/desktop
npm run gateway:test
npm test --workspace @rhzycode/transferserver
```

真实 Provider 和 Codex 冒烟按需执行：

```powershell
npm run smoke:agent --workspace @rhzycode/desktop -- --live
```

## 文档

从 [文档索引](docs/README.md) 开始。索引说明每份文档的用途、事实来源和维护边界。

## 安全底线

- 不提交 `.env`、API Key、移动 KEY、Codex 登录状态、证书或私钥。
- 不把桌面回环控制面改为局域网或公网监听。
- 不让 renderer 直接获得 Node.js、文件系统或未校验 IPC 能力。
- 不把 Provider Key、秘密回答或认证 header 写入日志、事件或快照。
- 正式分发必须替换仓库当前的开发签名配置，并在真实设备上验证安装、升级和回滚。
