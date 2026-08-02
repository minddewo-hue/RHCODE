# RHZYCODE 桌面端开发

本文档描述 Electron 桌面应用的当前开发方式。系统级边界见 [系统架构](architecture.md)，跨端协议见 [移动连接](mobile-connection.md)。

## 职责

桌面端负责：

- Electron main、preload 和 React renderer。
- Codex App Server 进程、JSONL RPC 和版本适配。
- 模型网关、Provider 凭据、模型目录和健康状态。
- 项目、对话、Turn、审批、结构化输入、附件、生成文件和终端。
- 回环控制面、桌面出站中转连接、移动 KEY 和事件回放。
- 本地加密状态、环境迁移、更新、打包和发布审计。

桌面端不应：

- 把 Codex 原始 RPC 暴露给 renderer 或移动端。
- 直接修改移动端状态模型而不更新共享协议。
- 使用用户默认 `%USERPROFILE%\.codex` 运行开发或测试。
- 把回环控制面改成 LAN/公网监听。
- 在 renderer 中开启 Node integration 或直接访问文件系统。

## 关键目录

| 路径 | 职责 |
| --- | --- |
| `desktop/src/main/index.ts` | Electron 生命周期、窗口安全配置、IPC 注册 |
| `desktop/src/main/runtime.ts` | Agent Host 和业务编排 |
| `desktop/src/main/app-server.ts` | Codex App Server JSONL 客户端 |
| `desktop/src/main/gateway-module.ts` | 内嵌模型网关生命周期 |
| `desktop/src/main/control-plane/` | 回环 HTTP/WS API、事件和 KEY |
| `desktop/src/main/desktop-relay-client.ts` | 出站中转注册和请求转发 |
| `desktop/src/main/control-persistence.ts` | 加密控制状态 |
| `desktop/src/main/credential-store.ts` | Provider 安全凭据 |
| `desktop/src/main/platform/` | Windows/macOS 平台适配 |
| `desktop/src/shared/desktop-api.ts` | main/preload/renderer 共享类型 |
| `desktop/src/preload/index.ts` | renderer 唯一 IPC 入口 |
| `desktop/src/renderer/` | 桌面 UI 与样式 |
| `desktop/model-gateway/` | Provider 和模型协议适配 |
| `desktop/test/` | 桌面与控制面测试 |

## 工具链

- Node.js 20+
- npm 11
- Electron 版本见 `desktop/package.json`
- Codex CLI 版本见 `desktop/codex-version.json`

打包时脚本会运行实际 Codex 二进制的 `--version`。版本与锁定文件不一致时构建失败。

## 开发隔离

不要让开发应用读取正式用户数据或默认 Codex Home：

```powershell
$runId = "desktop-dev-$PID"
$env:RHZYCODE_USER_DATA_DIR = Join-Path $env:TEMP "$runId-user-data"
$env:RHZYCODE_CODEX_HOME = Join-Path $env:TEMP "$runId-codex-home"
$env:RHZYCODE_SKIP_ENVIRONMENT_MIGRATION = "1"
npm run dev:desktop
```

常用变量：

| 变量 | 用途 |
| --- | --- |
| `RHZYCODE_USER_DATA_DIR` | 覆盖 Electron `userData` |
| `RHZYCODE_CODEX_HOME` | 指定应用私有 Codex Home |
| `RHZYCODE_CODEX_PATH` | 指定 Codex 可执行文件 |
| `RHZYCODE_GATEWAY_HOME` | 指定外部网关配置目录 |
| `RHZYCODE_TRANSFER_SERVER_URL` | 指定桌面出站中转 origin |
| `RHZYCODE_SKIP_ENVIRONMENT_MIGRATION` | 测试时禁用首次环境迁移 |
| `RHZYCODE_STARTUP_TRACE` | 写入不含秘密的启动诊断 |

Provider Key 的变量名由 `desktop/gateway.config.json` 声明。不要在文档、日志或测试输出中枚举真实值。

## 启动与验证

从仓库根目录运行：

```powershell
npm run dev:desktop
npm run typecheck --workspace @rhzycode/desktop
npm test --workspace @rhzycode/desktop
npm run test:ui --workspace @rhzycode/desktop
```

共享协议或控制面有变化时运行：

```powershell
npm run check
npm run build
npm test --workspace @rhzycode/transferserver
```

## 运行数据流

```text
Renderer action
  -> preload typed API
  -> main IPC validation
  -> DesktopRuntime
  -> Codex App Server / Gateway / local store
  -> domain state update
  -> renderer IPC event + control-plane AgentEvent
```

规则：

- renderer 输入必须在 main 边界重新校验。
- preload 只暴露明确方法，不提供通用 `invoke`。
- 每个 React 订阅必须在 effect 清理时调用 `Unsubscribe`。
- 后台线程事件按 `threadId` 隔离，不得写入当前线程视图。
- snapshot/WSS 是移动端权威状态；HTTP 命令成功只表示桌面已接受或完成命令。

## IPC 变更

新增或修改 IPC 时同步更新：

1. `desktop/src/shared/desktop-api.ts` 的类型。
2. main 中的 handler 和运行时入参校验。
3. `desktop/src/preload/index.ts` 的最小暴露方法。
4. renderer 调用点和订阅清理。
5. IPC 校验测试和受影响的 UI 测试。

不要在文档维护完整 IPC 方法清单；`DesktopApi` 接口是当前事实来源。

## Codex 与模型网关

启动顺序：

1. 解析网关目录和 Provider 凭据。
2. 在随机内部端口启动内嵌模型网关。
3. 用应用私有 Codex Home 启动 `codex app-server --stdio`。
4. 将 App Server 通知转换为 RHZYCODE 线程、时间线和请求对象。

升级 Codex 后至少验证：

- 模型目录和新建/恢复对话。
- 流式回复、命令、文件修改和历史加载。
- 审批、结构化输入、中断和重试。
- sandbox 与 approval policy 映射。
- 终端、生成文件和应用重启恢复。

模型网关只负责推理。Provider Key 从安全凭据或开发环境加载，不能进入 Codex 配置、renderer state 或移动协议。

## 状态与安全存储

桌面状态位于 Electron `userData`：

| 数据 | 行为 |
| --- | --- |
| 控制快照与耐久事件 | `safeStorage` 加密；恢复时保持单调 sequence |
| 移动访问 KEY 和审计 | `safeStorage` 加密；轮换后旧连接立即失效 |
| Provider 凭据 | 加密保存，只向 renderer 返回配置状态 |
| 项目目录 | 桌面权威管理并持久化 |
| 待审批/待输入请求 | 不跨 App Server 重启恢复 |

恢复损坏数据时应安全回退，不输出解密正文、KEY、项目内容或路径之外的敏感信息。

## UI 开发

- 保持桌面现有设计系统、浅色/夜间主题和紧凑工作区布局。
- 图标按钮必须有可访问名称和 hover tooltip。
- 最小窗口、标准窗口和高 DPI 下不得出现遮挡或文字溢出。
- 主题颜色应使用 CSS 变量或现有状态类，不在组件中复制一套固定色。
- 影响 UI 的变更运行 Playwright 截图测试并检查实际截图。

## 冒烟测试

模型与真实 Agent 冒烟：

```powershell
npm run smoke:agent --workspace @rhzycode/desktop
npm run smoke:agent --workspace @rhzycode/desktop -- --live
npm run smoke:agent --workspace @rhzycode/desktop -- --history
npm run smoke:agent --workspace @rhzycode/desktop -- --command
npm run smoke:agent --workspace @rhzycode/desktop -- --interrupt
npm run smoke:agent --workspace @rhzycode/desktop -- --terminal
```

模型矩阵脚本当前依赖一个未提交的验证 fixture；修复该前置条件后再运行：

```powershell
npm run smoke:models --workspace @rhzycode/desktop
npm run smoke:models:coding --workspace @rhzycode/desktop
```

真实冒烟使用专用 `RHZYCODE_SMOKE_CODEX_HOME`，不得读取默认 Codex Home 或输出 Provider Key。

## 打包

```powershell
npm run pack:desktop
npm run dist:desktop
npm run audit:release --workspace @rhzycode/desktop
```

打包脚本会验证 Codex 版本、扫描敏感文件并生成 `desktop/release/release-manifest.json`。签名和更新发布见 [发布流程](release.md) 与 [更新系统](update-system.md)。

## 交付检查

- [ ] 使用隔离 `userData` 和 Codex Home 冷启动。
- [ ] 桌面 typecheck/test 通过；UI 变更运行 Playwright。
- [ ] 协议变化同步 desktop/mobile/transferserver 测试。
- [ ] renderer 无 Node 权限，IPC 入参有运行时校验。
- [ ] 日志、事件、快照和产物不含密钥或秘密回答。
- [ ] 后台线程、恢复、断线和 KEY 轮换无回归。
- [ ] 影响发行时完成打包审计和目标平台安装验证。
