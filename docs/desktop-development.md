# RHZYCODE 桌面端开发文档

本文档面向独立承担桌面端任务的开发者。内容以当前仓库代码为准。开始开发前先阅读本文档和 `docs/architecture.md`；涉及手机联调时同时阅读 `docs/mobile-connection.md`。

## 1. 任务边界

### 1.1 桌面任务负责范围

- Electron 主进程、preload 安全桥和 React renderer。
- Codex App Server 子进程的启动、停止、JSONL RPC 和版本适配。
- 内嵌模型网关的生命周期、模型目录、Provider 状态和凭据入口。
- 本机线程、Turn、审批、结构化用户输入、附件、终端及活动时间线。
- 桌面内嵌控制面、移动端长期 KEY、事件回放和轮换。
- Windows DPAPI 持久化、自动更新、Windows 打包与签名门禁。
- `desktop/test`、桌面冒烟脚本及桌面相关的控制面测试。

### 1.2 未经协调禁止修改的范围

- 不修改 `mobile/`。手机端由另一任务独立开发。
- 不直接修改 `packages/protocol/src/index.ts` 中的跨端 schema。确需变更时，先形成兼容方案，并同时通知手机任务。
- 不把 Codex App Server 原始 RPC 结构暴露给移动端或作为公共协议。
- 不把 Provider API Key、Codex 认证信息、TLS 私钥或移动 KEY 传给日志、快照或移动端事件。
- 不读取、覆盖或复用用户默认的 `%USERPROFILE%\.codex`、`config.toml`、`auth.json`。开发和测试必须使用隔离目录。
- 不把局域网 HTTP/WS 控制端口转发到公网。
- 不提交 `.env`、证书、私钥、签名证书、密码或任何真实密钥。
- 不绕过 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，也不在 renderer 中引入 Node.js 文件系统能力。
- 不让桌面任务和手机任务同时无协调地修改 `desktop/src/main/control-plane/`、`packages/protocol/` 或移动连接格式。

### 1.3 建议的并行文件所有权

桌面任务可独占：

```text
desktop/**
docs/desktop-development.md
```

手机任务可独占：

```text
mobile/**
docs/mobile-development.md
```

共享且修改前必须协调：

```text
packages/protocol/**
desktop/src/main/control-plane/**
docs/architecture.md
docs/mobile-connection.md
package.json
package-lock.json
```

安装依赖会修改根 `package-lock.json`。两个任务不要同时执行依赖安装；由先完成的一方提交锁文件，另一方基于最新锁文件重新安装和验证。

## 2. 架构与关键文件

### 2.1 运行拓扑

```text
React Renderer
    | window.rhzycode（受限 IPC）
Preload
    | ipcRenderer.invoke / ipcRenderer.on
Electron Main
    |-- DesktopRuntime
    |     |-- AppServerClient -- JSONL/stdin/stdout --> codex app-server
    |     |-- GatewayModule --> 内嵌 desktop/model-gateway
    |     `-- 内嵌 Control Plane --> HTTP/WS 或 HTTPS/WSS --> 已授权手机
    |-- ProviderCredentialStore --> Electron safeStorage / Windows DPAPI
    |-- EncryptedControlPersistence --> Windows DPAPI
    |-- MobileAccessManager + EncryptedStateFile --> Windows DPAPI
    `-- UpdateManager --> electron-updater
```

关键原则：模型网关只负责推理路由；`DesktopRuntime` 是 App Server 版本适配和任务状态转换边界；renderer 与手机只消费 RHZYCODE 域状态，不应理解 Codex 内部 RPC。

### 2.2 关键文件

| 文件 | 职责 |
| --- | --- |
| `desktop/src/main/index.ts` | Electron 启动、窗口安全选项、隔离路径、DPAPI 对象、IPC 注册、清理退出 |
| `desktop/src/main/runtime.ts` | 网关/App Server/控制面编排；线程、Turn、审批、输入、附件、终端和事件映射 |
| `desktop/src/main/app-server.ts` | 启动 `codex app-server --stdio`，处理 JSONL RPC、超时、响应和诊断 |
| `desktop/src/main/gateway-module.ts` | 内嵌网关生命周期、60 秒 Provider 主动探测和状态事件 |
| `desktop/src/main/credential-store.ts` | 从网关配置发现凭据环境变量，使用 safeStorage 加密保存 |
| `desktop/src/main/control-persistence.ts` | 加密持久化控制快照、耐久事件和移动访问状态 |
| `desktop/src/main/update-manager.ts` | 更新检查、下载、安装状态机 |
| `desktop/src/preload/index.ts` | renderer 唯一允许使用的桌面 API；是 IPC 方法名和参数的直接来源 |
| `desktop/src/renderer/src/App.tsx` | 工作区、线程、Activity、Gateway、Settings、终端和移动连接 UI |
| `desktop/src/renderer/src/styles.css` | 桌面响应式布局和组件样式 |
| `desktop/src/main/control-plane/app.ts` | HTTP/WSS 接口、KEY 认证和控制面服务 |
| `desktop/src/main/control-plane/store.ts` | 快照、单调序列、事件应用、回放及耐久状态筛选 |
| `desktop/src/main/control-plane/mobile-access.ts` | 长期 KEY、使用状态、命令审计和轮换 |
| `packages/protocol/src/index.ts` | 桌面与手机共享的 Zod schema 和 TypeScript 类型 |
| `desktop/scripts/smoke-agent.ts` | 模型目录、真实 Turn、历史、命令、打断、终端冒烟 |
| `desktop/scripts/smoke-mobile-access.mjs` | 已打包应用的 KEY 认证、加密恢复和轮换冒烟 |
| `desktop/scripts/package-release.mjs` | Codex 版本门禁、敏感文件排除、签名、NSIS 和更新通道 |

控制面已内嵌到桌面主进程；实现判断以 `desktop/src/main/control-plane/`、测试和本文档为准。

## 3. 环境要求与开发隔离

### 3.1 工具链

- Node.js 20 或更高版本。
- npm 11.x；仓库声明为 `npm@11.6.2`。
- Windows 桌面发行路径依赖 PowerShell、Electron 43.1.1、electron-builder 26.15.3。
- 打包时要求可执行的 Codex CLI 0.144.6，版本由 `desktop/codex-version.json` 固定。

在仓库根目录安装依赖：

```powershell
npm install
```

### 3.2 必须使用的隔离变量

推荐每个桌面开发任务使用独立目录和端口：

```powershell
$runId = "desktop-dev-$PID"
$env:RHZYCODE_USER_DATA_DIR = Join-Path $env:TEMP "$runId-user-data"
$env:RHZYCODE_CODEX_HOME = Join-Path $env:TEMP "$runId-codex-home"
$env:RHZYCODE_SYNC_HOST = "127.0.0.1"
$env:RHZYCODE_SYNC_PORT = "8890"
npm run dev:desktop
```

- `RHZYCODE_USER_DATA_DIR`：覆盖 Electron `userData`，隔离 DPAPI 状态、凭据和日志。
- `RHZYCODE_CODEX_HOME`：隔离 App Server 的 `CODEX_HOME`。不要指向默认 `.codex`。
- `RHZYCODE_SYNC_HOST` / `RHZYCODE_SYNC_PORT`：控制面监听地址；默认 `127.0.0.1:8790`。
- `RHZYCODE_GATEWAY_HOME`：可选外部网关目录；目录必须包含 `gateway.config.json`。
- `RHZYCODE_CODEX_PATH`：可选 Codex 可执行文件路径；打包时也用它定位固定版本。
- `RHZYCODE_STARTUP_TRACE=1`：仅诊断启动阶段，写入隔离 `userData/startup-trace.log`。

冒烟专用变量：

- `RHZYCODE_SMOKE_CODEX_HOME`：`smoke:agent` 的隔离 Codex Home。
- `RHZYCODE_SMOKE_MODEL`：真实模型冒烟使用的模型 ID。

Provider 所需环境变量由 `gateway.config.json` 的 `api_key_env` 声明动态决定。文档、日志和测试输出只能显示 Provider 是否已配置，不得显示实际值。

### 3.3 并行任务端口规则

- 桌面内嵌控制面默认占用 `8790`。
- `npm run dev:control` 的独立开发服务器也默认占用 `8790`，不能与桌面实例同时使用同一端口。
- 独立 `dev:control` 未传入 `MobileAccessManager`，因此不等同于桌面内嵌的认证控制面，不能用它代替端到端手机认证联调。
- `smoke:mobile-access` 固定使用控制端口 `8791` 和 CDP 端口 `9336`；运行前确保端口空闲。

## 4. 启动与构建命令

所有命令从仓库根目录运行：

```powershell
# 桌面开发：先构建 protocol/control-plane，再启动 electron-vite
npm run dev:desktop

# 全仓类型检查和测试
npm run check

# 构建 protocol、control-plane 和 desktop
npm run build

# 只验证桌面
npm run typecheck --workspace @rhzycode/desktop
npm test --workspace @rhzycode/desktop

# Windows 解包目录和 NSIS 安装包
npm run pack:desktop
npm run dist:desktop
```

开发模式 renderer 通常由 Vite 提供，主进程读取 `ELECTRON_RENDERER_URL`；打包模式加载 `out/renderer/index.html`。不要在业务代码中硬编码 Vite 地址。

## 5. IPC 契约

renderer 只能通过 `window.rhzycode` 调用 preload。增加或修改 IPC 时，必须同时更新：

1. `desktop/src/main/index.ts` 的 `ipcMain.handle` 或事件发送。
2. `desktop/src/preload/index.ts` 的受限方法。
3. renderer 类型和使用点。
4. 对应单元测试；跨端行为还需协议/控制面测试。

### 5.1 请求/响应方法

| Preload 方法 | IPC channel | 参数/用途 |
| --- | --- | --- |
| `getAgentStatus` | `agent:status` | 获取 App Server 连接状态 |
| `connectAgent` | `agent:connect` | 启动网关并连接 App Server |
| `listModels` | `agent:models` | 调用 `model/list`，最多 100 项且不含隐藏模型 |
| `listThreads` | `agent:threads` | `{cwd?, searchTerm?, archived?}`，服务端搜索/归档列表 |
| `openThread` | `agent:thread:open` | `threadId`，恢复线程和历史 |
| `startThread` | `agent:thread:start` | `{cwd, model?, approvalPolicy?, sandboxMode?}` |
| `archiveThread` | `agent:thread:archive` | `threadId` |
| `unarchiveThread` | `agent:thread:unarchive` | `threadId` |
| `renameThread` | `agent:thread:rename` | `threadId, name`；名称归一化且最多 200 字符 |
| `deleteThread` | `agent:thread:delete` | `threadId`，永久删除 |
| `startTurn` | `agent:turn:start` | `{threadId, text, model?, approvalPolicy?, sandboxMode?, attachments?}`; `model` overrides this and subsequent turns on the same thread |
| `interruptTurn` | `agent:turn:interrupt` | `threadId`，内部必须已有活动 `turnId` |
| `chooseProject` | `project:choose` | 系统目录选择器，返回路径或 `null` |
| `chooseFiles` | `project:choose-files` | 系统多文件选择器，返回附件元数据，不返回文件内容 |
| `get/start/stop/restartGateway` | `gateway:*` | 网关状态及生命周期 |
| `probeProviders` | `gateway:probe` | 立即执行 Provider 主动健康探测 |
| `getCredentialStatus` | `credentials:status` | 只返回配置状态和来源 |
| `setProviderCredential` | `credentials:set` | `providerId, apiKey`；保存后重启网关，空字符串表示清除 |
| `get/check/download/installUpdate` | `updates:*` | 更新状态机操作 |
| `getMobileAccessStatus` | `mobile-access:status` | 长期 KEY 和命令审计状态 |
| `rotateMobileAccessKey` | `mobile-access:key:rotate` | 生成新 KEY 并立即使旧 KEY 失效 |
| `getSyncStatus` | `sync:status` | 控制面监听状态、URL、端口和错误 |
| `getSyncSnapshot` | `sync:snapshot` | 本进程直接读取 `ControlSnapshot`，不走 HTTP 认证 |
| `resolveApproval` | `sync:approval:resolve` | `id, approved|declined` |
| `resolveUserInput` | `sync:user-input:resolve` | `id, Record<questionId,string[]>` |
| `getTerminalStatus` | `terminal:status` | 获取单一 PTY 会话状态 |
| `startTerminal` | `terminal:start` | `{cwd, cols?, rows?}` |
| `writeTerminal` | `terminal:write` | `processId, data` |
| `resizeTerminal` | `terminal:resize` | `processId, cols, rows` |
| `stopTerminal` | `terminal:stop` | `processId` |

`approvalPolicy` 允许 `on-request`、`untrusted`、`never`。`sandboxMode` 允许 `read-only`、`workspace-write`、`danger-full-access`。

当前固定的 Codex CLI 0.144.6 在 Windows Code Mode 文件工具上仍需关注该上游限制：即使 session `cwd` 与 `writable_roots` 正确，`workspace-write` 的 `apply_patch` 和写文件命令仍可能被误判为 `writing outside of the project`。桌面不得自动升级为 Full access；需要写入的本机测试必须由用户显式选择 `danger-full-access`，并把项目范围写入任务提示。升级 Codex 后应先运行 `validation/workspace-write-smoke` 回归，再移除此限制说明。

附件格式为：

```ts
type ComposerAttachment = {
  path: string;                 // 必须是绝对路径
  name: string;
  kind: "file" | "image";
  size: number;
};
```

每个 Turn 最多 20 个附件。图片转成 App Server `localImage` 输入；普通文件只把绝对路径附加到文本提示中，不读取文件并通过 IPC 传输。

### 5.2 Main 到 renderer 事件

| Preload 订阅 | IPC channel | 内容 |
| --- | --- | --- |
| `onAgentStatus` | `agent:status` | App Server 连接状态 |
| `onAgentMessage` | `agent:message` | 原始 App Server 通知，仅供桌面适配/UI 使用 |
| `onDiagnostic` | `agent:diagnostic` | App Server stderr/诊断，不得含秘密 |
| `onGatewayStatus` | `gateway:status` | 网关、Provider、模型和健康状态 |
| `onSyncStatus` | `sync:status` | 内嵌控制面状态 |
| `onSyncEvent` | `sync:event` | 稳定的 `AgentEvent` 域事件 |
| `onTerminalStatus` | `terminal:status` | PTY 生命周期状态 |
| `onTerminalOutput` | `terminal:output` | `{processId, delta, stream, capReached}` |
| `onUpdateStatus` | `updates:status` | 更新状态、版本、进度、错误 |
| `onMobileAccessStatus` | `mobile-access:status` | 长期 KEY 状态变化 |

每个订阅必须返回并在 React effect 清理阶段调用 `Unsubscribe`，避免 HMR 或视图重建后重复监听。

## 6. 数据流

### 6.1 网关与 Agent Host

1. 主进程解析网关目录，加载 Provider 凭据到主进程环境。
2. `GatewayModule` 使用随机内部端口启动 `desktop/model-gateway`。
3. `DesktopRuntime.startAgent()` 用 `-c` 参数把内部网关配置传给隔离的 Codex App Server。
4. `AppServerClient` 启动 `codex app-server --stdio`，通过逐行 JSON 收发 RPC。
5. App Server 原始通知由 `DesktopRuntime` 转换为 `ThreadSummary`、`TimelineItem`、`ApprovalRequest`、`UserInputRequest` 和 `AgentEvent`。
6. renderer 通过 IPC 获取桌面交互；手机通过认证控制面获取稳定域事件。

App Server 配置覆盖当前包括内部 Provider 名称、网关 `base_url`、`responses` wire API 和 `codex-model-catalog.json`。不要要求用户修改默认 Codex 配置来使用桌面应用。

### 6.2 Turn 与审批

```text
Renderer startTurn
  -> Main 校验项目路径、sandbox、附件
  -> App Server turn/start
  -> App Server 流式通知
  -> DesktopRuntime 更新 ControlStore
  -> IPC sync:event + WSS AgentEvent
  -> 桌面或具备 approvals:write 的手机决定审批
  -> DesktopRuntime 把决定映射回原 RPC id
```

附加权限审批只作用于当前 Turn：批准返回请求中的权限和 `scope: "turn"`；拒绝返回空权限和同一 scope。关闭/重启网关时，待处理审批会被拒绝，待处理用户输入会以空答案结束。

### 6.3 持久化

- `control-state.bin`：DPAPI 加密的快照和耐久事件。
- `mobile-access-state.bin`：DPAPI 加密的长期 KEY 和命令审计。
- `gateway-credentials.json`：值是 safeStorage 加密后的 Base64，不是明文凭据。
- 默认均位于 Electron `userData`；开发时由 `RHZYCODE_USER_DATA_DIR` 隔离。

控制面最多保留 2,000 个事件和 2,000 个时间线项。只持久化 `host.status`、`thread.updated`、`thread.removed`、`timeline.upserted`。待处理审批和用户输入依赖活跃 App Server RPC，重启后不得恢复；恢复时原 `running/waiting_*` 线程会转换为 `interrupted` 并写回权威事件序列。

## 7. 当前功能清单

- 项目选择、最近项目、线程列表、搜索、恢复、重命名、归档、取消归档和永久删除。
- 模型目录发现和模型选择。
- 流式对话、Activity 时间线、命令输出、推理摘要、文件变更、重试错误和 Turn 打断。
- 命令、文件、附加权限审批；结构化/秘密用户输入。
- `read-only`、项目限定 `workspace-write`、显式 `danger-full-access` sandbox。
- 文件/图片附件，最多 20 个。
- App Server PTY 终端、stdin、resize、输出缓冲和终止。
- 内嵌多模型网关、启动/停止/重启和 Provider 主动健康探测。
- Provider 凭据 DPAPI 存储，renderer 只见状态。
- 控制快照/事件加密持久化和事件断线回放。
- 长期移动 KEY、加密持久化、命令审计和立即轮换。
- 远程线程/Turn、结构化答案和线程生命周期命令，安全默认策略、幂等重放和非敏感审计。
- HTTP Bearer 与 WSS subprotocol 认证。
- 证书驱动的 HTTPS/WSS 控制面。
- 更新检查、下载、安装重启状态机；无签名更新通道时禁用。
- Windows 解包目录和 NSIS x64 安装包。

## 8. 手机端接口契约

本节是两个并行任务的稳定交界面。手机不得调用桌面 IPC、App Server RPC 或模型网关。

### 8.1 连接信息

桌面 Settings 的 Mobile connection 显示本机 LAN IP、端口和一个 `rhzy_...` 长期 KEY。KEY 通过 DPAPI 加密保存，在用户手动重新生成前持续有效。手机直接用 KEY 认证，不存在额外的兑换请求。

### 8.2 HTTP/WSS API

| 方法 | 路径 | 认证 | 当前用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | 存活检查 |
| `GET` | `/v1/snapshot` | `Authorization: Bearer <KEY>` | 获取完整 `ControlSnapshot` |
| `GET` WebSocket | `/v1/events?after=<sequence>` | subprotocol | 回放并订阅 `AgentEvent` |
| `POST` | `/v1/approvals/:id` | Bearer | `{decision:"approved"|"declined"}` |
| `POST` | `/v1/commands/threads/start` | Bearer + Idempotency-Key | 从桌面已知项目创建线程 |
| `POST` | `/v1/commands/threads/:id/turns/start` | Bearer + Idempotency-Key | 启动无附件 Turn |
| `POST` | `/v1/commands/threads/:id/turns/interrupt` | Bearer + Idempotency-Key | 打断活跃 Turn |
| `GET` | `/v1/commands/threads/archived?searchTerm=` | Bearer | 实时查询最多 100 条归档线程，不写入活动 snapshot |
| `POST` | `/v1/commands/user-inputs/:id/submit` | Bearer + Idempotency-Key | `{answers}` 回答当前结构化输入；答案不进入事件或审计 |
| `POST` | `/v1/commands/threads/:id/rename` | Bearer + Idempotency-Key | `{name}`，归一化后最多 200 字符 |
| `POST` | `/v1/commands/threads/:id/archive` | Bearer + Idempotency-Key | 归档非活跃线程并发布 removal |
| `POST` | `/v1/commands/threads/:id/unarchive` | Bearer + Idempotency-Key | 恢复归档线程并重新发布权威摘要 |
| `DELETE` | `/v1/commands/threads/:id` | Bearer + Idempotency-Key | 永久删除非活跃线程并审计目标 ID |

WebSocket 客户端必须使用：

```ts
new WebSocket(
  `${controlUrl.replace(/^http/, "ws")}/v1/events?after=${lastSequence}`,
  ["rhzycode.v1", `rhzycode.auth.${accessKey}`],
);
```

推荐重连顺序：携带 Bearer 获取快照，原子替换本地状态，记录 `snapshot.lastSequence`，再以 `after=lastSequence` 建立 WSS。收到事件后按 `sequence` 单调推进；事件重复时按 ID/upsert 语义处理，不能假定序号连续，因为非耐久事件在重启后不会回放。

远程写命令的 `Idempotency-Key` 为 8-200 位字母、数字或 `._:-`。同一移动客户端和 key 的相同成功请求在 10 分钟内返回同一结果；不同请求复用 key 为 `409`；只读归档列表不要求该 header。远程协议支持 `read-only|workspace-write|danger-full-access` 和 `on-request|untrusted|never`；手机版默认使用 `danger-full-access + never`。附件必须使用协议内的受限上传数据，不能提交手机本地路径。答案正文只在当前调用中交给 App Server；幂等缓存只保存 SHA-256 指纹和非敏感响应，事件/审计只含 request ID。活跃、待审批或待输入线程不能被远程归档或永久删除。

HTTP 语义：无效或已更换 KEY 为 `401`；审批/线程/项目不存在为 `404`；状态或幂等冲突为 `409`；桌面 Agent 不可用为 `503`；请求结构错误为 `400`。重新生成 KEY 会立即以 `4001` 关闭现有 WSS，旧 KEY 的 HTTP 和重连返回 `401`。

### 8.3 共享数据类型

唯一 schema 来源是 `packages/protocol/src/index.ts`：

- `ControlSnapshot`：`hosts`、`threads`、`timeline`、`approvals`、`userInputs`、`lastSequence`。
- `AgentEvent`：`host.status`、`thread.updated`、`thread.removed`、`timeline.upserted`、`approval.requested`、`approval.resolved`、`user_input.requested`、`user_input.resolved`。
- 时间均为 ISO-8601；状态枚举不得在客户端自行扩展。

当前远程控制 API 已支持创建线程、发起无附件 Turn、打断活跃 Turn、提交结构化答案，以及线程改名/归档/恢复/永久删除；HTTP 成功只表示桌面 App Server 已完成或接受命令，手机仍必须用 snapshot/WSS 事件作为权威状态。归档视图不得写回活动 snapshot。尚不支持 steering/retry、终端控制、附件上传、修改 Provider 凭据或跨桌面路由。

## 9. HTTPS/WSS 配置

桌面默认监听 `0.0.0.0:8790`，并在 Settings 展示优先的物理 LAN IPv4。可信局域网允许 HTTP/WS；托管部署可以配置证书和私钥启用 HTTPS/WSS：

```powershell
$env:RHZYCODE_SYNC_HOST = "192.168.1.20"
$env:RHZYCODE_SYNC_PORT = "8790"
$env:RHZYCODE_SYNC_TLS_CERT = "C:\secure\control-fullchain.pem"
$env:RHZYCODE_SYNC_TLS_KEY = "C:\secure\control-private-key.pem"
$env:RHZYCODE_SYNC_TLS_CA = "C:\secure\control-ca.pem" # 可选
npm run dev:desktop
```

要求：

- 证书 SAN 必须包含手机访问使用的 IP 或 DNS 名称。
- 手机操作系统必须信任证书链；普通自签证书通常会被 iOS/Android 拒绝。
- cert/key 必须成对配置；只配一个会启动控制面失败。
- 私钥只由主进程读取，不进入 renderer、安装包、QR 或日志。
- 限制私钥 ACL，仅允许桌面运行用户读取。
- 不把明文 `8790` 暴露到互联网；局域网防火墙只开放所需来源。

## 10. 安全要求

- Electron 窗口必须保持上下文隔离、关闭 Node integration、开启 sandbox。
- 所有 renderer 输入在主进程边界重新验证；不要把 preload 当成可信验证层。
- 凭据保存前要求 `safeStorage.isEncryptionAvailable()`；不可回退到明文。
- API Key 不得出现在 `CredentialStatus`、错误文本、Provider 健康结果或 renderer state 中。
- 长期 KEY 只保存在 DPAPI 加密状态文件中；renderer 仅在设置页按用户请求显示。
- 移动访问状态恢复时忽略格式异常的 KEY 和审计记录。
- 用户秘密答案只响应给活跃 App Server RPC，不进入事件历史或控制快照。
- 附件只允许绝对路径，限制为 20 项；后续若读取或上传文件，必须新增大小、类型、路径范围和符号链接检查。
- `workspace-write` 只允许项目根目录写入且默认无网络；`danger-full-access` 必须保持显式选择。
- 移动访问启用时，手机不能调用 `/v1/hosts`、`/v1/threads`、`/v1/events` 发布状态。
- 发行包必须继续排除 `.env`、`auth.json`、`config.toml`，且不得增加证书/状态文件资源。
- 日志仅记录经过清洗的错误；不得记录请求 Authorization、WSS KEY subprotocol、用户输入答案或完整环境。

## 11. 测试、冒烟与打包

### 11.1 提交前快速验证

```powershell
npm run typecheck --workspace @rhzycode/desktop
npm test --workspace @rhzycode/desktop
npm run test:ui --workspace @rhzycode/desktop
npm test --workspace @rhzycode/desktop
```

共享协议或控制面变化必须运行：

```powershell
npm run check
npm run build
```

当前测试覆盖：TLS 配置、秘密输入不落盘、Turn 级权限、审批策略、sandbox/附件映射、线程搜索/归档/重命名/删除、重试状态、凭据加密、控制状态恢复、更新状态机、长期 KEY 轮换、WSS 认证和异常状态恢复。Playwright Electron 测试使用隔离用户目录和确定性 IPC 覆盖最小窗口、键盘导航、项目菜单、附件、sandbox、线程生命周期、删除确认、审批、Settings、移动连接和终端状态切换。

### 11.2 Agent 冒烟

```powershell
# 默认：模型目录
npm run smoke:agent --workspace @rhzycode/desktop

# 需要可用 Provider 和实际模型
npm run smoke:agent --workspace @rhzycode/desktop -- --live
npm run smoke:agent --workspace @rhzycode/desktop -- --history
npm run smoke:agent --workspace @rhzycode/desktop -- --command
npm run smoke:agent --workspace @rhzycode/desktop -- --interrupt
npm run smoke:agent --workspace @rhzycode/desktop -- --terminal
```

真实冒烟只使用测试专用隔离 `RHZYCODE_SMOKE_CODEX_HOME`；不要借用默认 Codex Home。不得在 CI 输出模型凭据。

### 11.3 打包及移动连接冒烟

```powershell
npm run pack:desktop
npm run smoke:mobile-access --workspace @rhzycode/desktop
npm run dist:desktop
```

`smoke:mobile-access` 要求先存在 `desktop/release/win-unpacked/RHZYCODE.exe`，验证：未签名包禁用更新、未认证请求为 401、Bearer 快照、DPAPI 文件无明文、重启后 KEY 可用、轮换后旧 KEY 返回 401，以及三字段连接 UI 可见。

### 11.4 签名和自动更新

签名发行：

```powershell
$env:CSC_LINK = "C:\secure\rhzycode-signing.pfx"
$env:CSC_KEY_PASSWORD = "<从安全环境注入>"
$env:RHZYCODE_REQUIRE_SIGNING = "1"
npm run dist:desktop
```

签名更新通道：

```powershell
$env:CSC_LINK = "C:\secure\rhzycode-signing.pfx"
$env:CSC_KEY_PASSWORD = "<从安全环境注入>"
$env:RHZYCODE_UPDATE_URL = "https://updates.example.com/rhzycode/windows"
$env:RHZYCODE_REQUIRE_SIGNING = "1"
npm run dist:desktop
```

规则：

- `RHZYCODE_REQUIRE_SIGNING=1` 但无签名身份时打包必须失败。
- 配置 `RHZYCODE_UPDATE_URL` 但无签名身份时也必须失败。
- 更新源来自打包生成的 `app-update.yml`，运行时环境变量不能替换已签名构建的源。
- 发布前验证 Codex 二进制版本严格为 0.144.6。
- 检查安装包和 `app.asar` 不含敏感配置、用户状态、TLS 文件或密钥。

## 12. 可并行继续开发的桌面待办

以下事项只涉及桌面目录，可以在不修改手机代码的前提下推进；一旦涉及控制 API，必须先同步契约。

### D1. IPC 强类型与运行时校验（已完成）

状态：`desktop/src/shared/desktop-api.ts` 统一 renderer/preload/main 使用的桌面 API 类型；主进程在所有带入参的 IPC 边界执行显式运行时校验，非法对象结构、路径、ID、策略、附件、回答、凭据和终端参数不会进入运行时。

- 把 renderer 中大量 `unknown` 强制转换收敛为共享的桌面 API 类型。
- 对 IPC 入参增加 Zod/显式校验，尤其是路径、线程 ID、Provider ID 和终端尺寸。
- 保持 preload API 最小化，不暴露通用 `invoke`。
- 该共享类型只属于桌面进程边界；移动端不得导入或调用桌面 IPC，移动状态仍以控制面的 snapshot + event sequence 为准。

验收：非法入参产生可预期错误且主进程不崩溃；renderer/preload/main 类型一致；新增单元测试；`npm run check` 通过。

### D2. 移动 KEY 即时轮换（已完成）

状态：重新生成 KEY 会立即以关闭码 `4001` 关闭现有 WSS；旧 KEY 的 HTTP 和重连返回 `401`。

- 记录 WebSocket 与移动访问身份的对应关系。
- 轮换 KEY 时主动关闭现存 socket，而不仅是在下次认证时拒绝。
- 不改变 Bearer/subprotocol 格式。

验收：使用 KEY 建立 WSS，桌面重新生成 KEY 后 socket 立即关闭；旧 KEY 的 HTTP 和重连均为 401。

### D3. 持久化和恢复可观测性（已完成）

状态：Settings 只显示 `restored`、`partial`、`missing`、`invalid`、`unavailable` 恢复枚举；损坏状态安全回退为空，不向 renderer 发送路径或解密内容。

- 为 DPAPI 不可用、文件损坏、恢复丢弃记录增加不含敏感数据的状态提示。
- 保持失败时安全回退为空状态，不输出解密内容。

验收：损坏文件不会阻止应用启动；UI 能识别“未恢复”；日志不含快照、移动 KEY、项目内容或凭据。

### D4. 桌面 UI 自动化和无障碍（已完成）

状态：Playwright 在真实 Electron renderer/preload 上运行，外部 Gateway/Provider 通过测试进程内的确定性 IPC handler 隔离；`1040x680` 和 `1440x900` 截图基线已纳入测试。窄窗口右侧面板改为可关闭覆盖层，所有关键控件具备可访问名称，项目菜单和模块入口支持键盘操作。

- 为线程、审批、sandbox、附件、Settings、终端增加 Playwright/Electron UI 测试。
- 修复焦点、键盘操作、对话框确认和窄窗口溢出。

验收：最小窗口 `1040x680` 无遮挡；按钮有可访问名称；键盘可完成主要工作流；截图基线稳定。

### D5. 发布产物完整性（已完成）

状态：打包自动审计 ASAR 与资源目录，生成含版本、大小、SHA-256、Authenticode 和更新状态的 `desktop/release/release-manifest.json`；`npm run audit:release --workspace @rhzycode/desktop` 可独立复核已有产物。

- 自动检查 `app.asar` 和 `extraResources` 敏感文件名单。
- 产出 SHA-256、版本、Codex 版本、签名状态和更新元数据报告。

验收：敏感文件命中时构建失败；签名要求不可绕过；干净环境能安装、启动、卸载；未签名开发包保持更新禁用。

### D6. 对话恢复与并发运行（已完成）

- 启动时恢复上次项目，并按项目恢复上次选中的对话；已失效的对话 ID 自动回退到当前项目第一条可用对话。
- `activeTurns`、renderer 运行集合和 Agent 事件均按 `threadId` 隔离；同一对话保持单 Turn，不同对话允许并行 Turn。
- 任一 Turn 运行时仍可切换项目、对话、终端和下一 Turn 模型。只有当前对话显示停止按钮；存在活动 Turn 时禁止停止或重启整个 Gateway。
- 后台对话的流式消息不得写入当前对话。Playwright 必须实际启动两个对话、切换并分别停止，同时验证重新加载后恢复选择。

### 共享待办，不能由桌面单方面实现

- 手机消费已冻结的远程线程/Turn、结构化答案和线程生命周期命令。
- 文件上传或跨设备附件传输。
- 角色、主机选择或多桌面路由。
- 公网中继、出站连接拓扑、设备推送通知。
- 协议版本协商和旧手机兼容期。

这些功能必须按“schema -> 鉴权 -> 服务端 -> 桌面适配 -> 手机 -> 端到端测试”的顺序设计。

## 13. 逐项验收标准

桌面任务每次交付至少满足：

1. 范围：只修改声明过的桌面文件；共享文件变更已告知手机任务并给出迁移说明。
2. 启动：使用隔离 `userData` 和 `CODEX_HOME` 冷启动成功，主进程和 renderer 无未捕获异常。
3. 安全：默认 Codex 配置未被修改；renderer 无 Node 权限；日志无密钥/秘密答案。
4. Agent：网关与 App Server 正常启动；模型列表可加载；断线和重连状态明确。
5. 线程：新建、恢复、搜索、重命名、归档、恢复和删除按受影响范围验证。
6. Turn：流式输出、审批、失败重试、打断及 sandbox 映射按受影响范围验证。
7. 控制面：快照与事件序列一致；重连按 `lastSequence` 回放；重启不恢复待处理 RPC。
8. 移动访问：KEY 生成、DPAPI 恢复、轮换、401 和 WSS `4001` 行为无回归。
9. 传输：可信局域网 HTTP/WS 可用；托管 HTTPS/WSS 用可信证书联调。
10. 自动化：至少运行桌面 typecheck/test；共享变更运行全仓 `check` 和 `build`。
11. 发行：影响主进程、资源或依赖时运行 `pack:desktop` 和 `smoke:mobile-access`；发布时再运行 `dist:desktop`。
12. 文档：IPC/API/schema/环境变量变化已同步更新桌面和手机开发文档。

## 14. 交付检查清单

- [ ] 变更说明包含功能、边界、风险和未完成项。
- [ ] 列出改动文件，确认没有无关格式化或生成物噪声。
- [ ] 没有提交 `.env`、API Key、Codex 认证、移动 KEY、证书或私钥。
- [ ] 使用隔离 `RHZYCODE_USER_DATA_DIR` 和 `RHZYCODE_CODEX_HOME` 验证冷启动。
- [ ] 桌面 typecheck 和 test 通过。
- [ ] 涉及共享边界时，全仓 `npm run check` 和 `npm run build` 通过。
- [ ] 涉及 App Server 时，执行对应 `smoke:agent` 模式。
- [ ] 涉及移动 KEY、持久化或主进程启动时，执行 `pack:desktop` 后的 `smoke:mobile-access`。
- [ ] 涉及 renderer 时，检查 `1440x900`、`1040x680` 和高 DPI 显示。
- [ ] 涉及手机契约时，提供请求/响应样例、状态码和兼容策略。
- [ ] 涉及发行时，验证 Codex 固定版本、签名门禁、更新门禁和产物敏感文件扫描。
- [ ] 把最终可执行命令、验证结果和剩余基础设施依赖交给集成人员。
