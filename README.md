# RHZYCODE

RHZYCODE 是一个以 Windows 桌面端为本地 Agent Host、以 Android 客户端为远程控制端的跨平台编程助手。桌面端负责运行 Codex App Server、模型网关、项目文件操作和命令执行；移动端通过可信局域网连接桌面端，查看任务、发送消息、处理审批并管理对话。

## 当前版本

| 客户端 | 版本 | 发布产物 |
| --- | --- | --- |
| Windows Desktop | `0.1.3` | NSIS x64 安装程序 |
| Android | `0.1.6`（versionCode `7`） | APK |

发布元数据由 `appupdate/channel.json` 管理，安装包默认写入本地发布目录且不提交到 Git。

## 主要功能

- 多模型编程对话：从内嵌模型网关加载可用模型，并支持模型、推理强度、审批策略和沙箱策略选择。
- 本地项目操作：创建和恢复任务、浏览项目目录、执行命令、应用文件修改、终止运行任务及查看执行过程。
- 完整任务管理：对话搜索、重命名、归档、恢复和永久删除；空对话也能在桌面端与移动端同步。
- 桌面与手机同步：使用桌面生成的长期访问 KEY，通过 HTTP/WebSocket 同步线程、消息、审批、用户输入和运行状态。
- 图片与文件附件：桌面支持文件选择和粘贴图片；Android 支持拍照、相册和文件选择，消息中显示可点击的图片缩略图。
- 内置终端：桌面端提供项目终端和实时输出。
- 应用更新：桌面端支持检查、下载并重启安装；Android 端校验 APK 大小和 SHA-256 后调用系统安装界面。
- 单实例桌面程序：重复启动时恢复并聚焦已有窗口。

## 系统结构

```text
Android Client
    |  Bearer KEY + HTTP / WebSocket
    v
Desktop Control Plane
    |-- Electron Renderer
    |-- Agent Host ------ Codex App Server (JSONL / stdio)
    |-- Model Gateway --- configured model provider
    |-- DPAPI storage --- credentials, access KEY, control state
    `-- Update Manager
```

桌面端是任务执行和持久化的权威节点。移动端不直接访问模型供应商，也不会接收供应商 API Key。共享接口和运行时校验统一定义在 `packages/protocol`。

## 仓库目录

```text
desktop/                    Electron 桌面端、Agent Host、控制面和模型网关
mobile/                     Expo / React Native Android 客户端及本地更新模块
packages/protocol/          桌面与移动端共享的协议和 Zod 校验结构
appupdate/                  Windows、Android 构建发布脚本与局域网更新服务
docs/                       架构、开发、连接、安全和发布文档
```

## 开发环境

基础要求：

- Windows 10/11
- Node.js 20 或更高版本
- npm 11 或更高版本
- 可执行的 Codex CLI；桌面发布使用 `desktop/codex-version.json` 固定的版本
- Android Studio、JDK 和 Android SDK（构建 Android 时）

安装依赖并运行检查：

```powershell
npm install
npm run check
```

启动桌面端：

```powershell
npm run dev:desktop
```

启动移动端：

```powershell
npm run dev:mobile
```

连接 Android 真机进行开发时，可按需要转发 Metro 和控制端口：

```powershell
adb reverse tcp:8081 tcp:8081
adb reverse tcp:8790 tcp:8790
npm run android --workspace @rhzycode/mobile
```

## 桌面与手机连接

桌面控制面默认监听 `0.0.0.0:8790`，并在设置中显示局域网地址、端口和访问 KEY。手机端添加电脑时填写这三项即可连接。

- KEY 持久化在 Windows DPAPI 加密文件中，可在桌面设置里重新生成。
- 普通信任局域网可使用 HTTP/WS；不要将 `8790` 端口映射到公网。
- 托管部署应配置受信任的 HTTPS/WSS 证书和网络访问策略。
- 供应商密钥仅从 `desktop/.env`、环境变量或桌面安全存储读取，不进入移动端和 Git 仓库。

详细连接说明见 [docs/mobile-connection.md](docs/mobile-connection.md)。

## 配置模型

模型路由位于 `desktop/gateway.config.json`。配置文件只保存供应商地址、模型映射和 API Key 环境变量名称，不保存密钥值。

源码开发可在 `desktop/.env` 配置供应商密钥：

```powershell
SUB2API_API_KEY=replace-with-your-key
```

安装版应在桌面设置中保存密钥。密钥由 Electron `safeStorage` 和 Windows DPAPI 加密。

## 首次启动迁移

桌面版首次启动时会分别检测用户 Codex 和 Claude 环境中的项目对话，并对两个来源分别询问是否迁移。迁移只复制会话历史并登记仍然存在的项目目录，不复制 API Key、登录状态或模型配置，也不会删除源文件。选择跳过后不会再次提示；迁移失败会在下次启动时重试。

Codex 会话保持原始 rollout 格式，Claude 会话通过 Codex App Server 的官方外部会话导入接口转换后写入 RHZYCODE 私有 `codex-home`。旧版 `desktop/model-gateway/gateway.config.json` 和安装包 `resources/gateway/gateway.config.json` 路径继续兼容。

## 构建与发布

构建 Windows x64 安装程序：

```powershell
npm run dist:desktop
```

产物写入 `desktop/release/`。发布流程会检查固定 Codex 版本、扫描敏感文件，并生成 SHA-256 和 Authenticode 状态清单。

构建 Android release APK：

```powershell
npm run update:build:mobile
```

汇总已有桌面和 Android 产物并更新发布通道：

```powershell
npm run update:publish
npm run update:serve
```

更新服务默认监听 `8791`，提供桌面更新通道、Android manifest、APK 和字节范围下载。生产发布应使用正式代码签名证书和 Android keystore；仓库默认开发配置不能替代生产签名。

## 验证命令

```powershell
# 全仓库类型检查和单元测试
npm run check

# 桌面 UI 自动化
npm run test:ui --workspace @rhzycode/desktop

# 模型网关测试
npm run gateway:test

# 桌面真实 Agent 冒烟
npm run smoke:agent --workspace @rhzycode/desktop -- --live
```

## 文档

- [系统架构](docs/architecture.md)
- [桌面端开发](docs/desktop-development.md)
- [移动端开发](docs/mobile-development.md)
- [桌面与手机连接](docs/mobile-connection.md)
- [更新系统](docs/update-system.md)
- [Windows 发布与安全](docs/release.md)
- [模型稳定性](docs/model-stability.md)
- [并行开发约束](docs/parallel-development.md)
- [项目路线图](docs/roadmap.md)

## 安全提示

- 不要提交 `.env`、供应商密钥、访问 KEY、证书私钥、Codex 登录状态或本机控制状态。
- 不要将明文局域网控制端口暴露到互联网。
- Android APK 和 Windows EXE 在正式分发前必须使用各自的生产签名证书。
- 更改协议、权限、附件或远程命令时，必须同步更新运行时校验和两端测试。
