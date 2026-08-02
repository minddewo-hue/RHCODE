# RHZYCODE 系统架构

## 当前拓扑

```text
Desktop Renderer
    | typed preload IPC
    v
Electron Main / DesktopRuntime
    |-- AppServerClient -- JSONL/stdin/stdout --> bundled Codex App Server
    |-- GatewayModule -------------------------> configured LLM providers
    |-- Control Plane (127.0.0.1, random port)
    |-- Relay Client -- outbound WebSocket ----> Transfer Server
    `-- safeStorage ----------------------------> encrypted local state

Mobile Client
    | Bearer HTTP + authenticated WebSocket
    v
Transfer Server
    | live request/event forwarding
    v
Desktop Relay Client -> loopback Control Plane -> DesktopRuntime
```

桌面是唯一的任务执行和持久化权威节点。中转服务只连接在线桌面与手机；电脑离线时返回 `503`，不提供离线任务队列。移动端保存访问 KEY 和本地导航状态，但不独立生成业务历史。

## 组件职责

### DesktopRuntime

- 管理 Codex App Server、模型网关、线程、Turn、审批、结构化输入和终端。
- 把版本相关的 Codex RPC 转换为 RHZYCODE 域对象。
- 维护项目目录、对话历史、生成文件和移动控制状态。
- 向 renderer 发送 IPC 事件，向控制面发布共享 `AgentEvent`。

### Model Gateway

- 加载 Provider 配置和凭据，提供模型目录与推理路由。
- 负责 Provider 健康检查、请求转发和错误清洗。
- 不拥有项目文件、任务生命周期、审批或对话持久化。

### Control Plane

- 只监听 `127.0.0.1` 的随机端口。
- 使用桌面生成的长期 KEY 验证 HTTP 和 WebSocket 请求。
- 提供完整 snapshot、单调事件序列、线程命令和受控文件访问。
- 写命令使用 `Idempotency-Key` 防止弱网重复执行。

### Transfer Server

- 接受桌面的出站注册连接和手机的 `/control` 请求。
- 内存中只保留 KEY 摘要与在线连接映射。
- 不持久化原始 KEY、任务、事件、附件或请求正文。
- 提供统一更新清单和 Windows/Android 安装包。

### Mobile Client

- 使用 SecureStore 分电脑保存 KEY。
- 先获取 snapshot，再按 `lastSequence` 建立事件连接。
- 对历史和实时事件执行运行时 schema 校验与幂等合并。
- 发送受限远程命令，不解释 Codex 私有 RPC。

## 数据与持久化

| 数据 | 位置 | 保护方式 |
| --- | --- | --- |
| Codex 会话和 App Server 状态 | 应用私有 `codex-home` | 桌面文件权限；不复用用户默认目录 |
| 控制快照与耐久事件 | Electron `userData` | `safeStorage` 加密 |
| 移动访问 KEY 与命令审计 | Electron `userData` | `safeStorage` 加密 |
| Provider API Key | 桌面安全凭据文件 | `safeStorage`；Windows 后端为 DPAPI |
| 手机连接 KEY | iOS/Android SecureStore | 系统安全存储 |
| 中转在线映射 | 中转进程内存 | 进程退出即丢失 |
| 更新安装包 | 中转 `updates/` | 发布哈希与客户端校验 |

待处理审批和结构化输入绑定活跃 App Server RPC，不在重启后恢复。重启时旧运行状态会转为中断，历史消息通过桌面权威数据重新加载。

## 协议边界

- `packages/protocol` 是桌面控制面与移动端共享类型的唯一来源。
- `packages/update-contract` 是发布器、中转服务和客户端更新清单的唯一来源。
- Codex App Server 原始 RPC 只能存在于桌面适配层，不得进入移动协议。
- renderer 只能通过受限 preload API 访问主进程，不能直接使用 Node.js。
- 桌面、手机和中转按同一当前协议协调发布；新增命令必须同时实现认证、运行时校验、幂等和跨端测试。
- 客户端不猜测旧字段或旧事件格式。外部 Codex RPC 只在桌面 Agent Host 边界按固定 CLI 版本转换。

## 传输与安全

- App Server 使用 JSONL stdio，不暴露网络监听。
- 桌面回环控制面不得改为 LAN 或公网监听。
- HTTP 使用 Bearer KEY；WebSocket 使用 `rhzycode.v1` 与 KEY subprotocol。
- Provider Key、移动 KEY、秘密回答和认证 header 不得进入日志、事件或更新包。
- 当前默认公网中转使用 HTTP/WS，无法防止链路窃听和篡改。无状态中转不能替代 TLS；正式生产部署应使用可信 HTTPS/WSS。
- Windows/macOS/Android/iOS 正式分发都必须使用平台生产签名身份。

## 平台边界

- 桌面操作系统差异集中在 `desktop/src/main/platform`。
- 移动平台差异集中在 `mobile/src/platform`、Expo config plugin 或原生 module。
- Apple 产物只能在 macOS/Xcode 环境构建和验证。
- 平台不支持的原生能力必须安全降级，不能在模块加载时导致其他平台崩溃。

## 版本策略

桌面发布固定一个 Codex CLI 版本，事实来源是 `desktop/codex-version.json`。打包脚本会执行 `codex --version` 并在不匹配时失败。升级 Codex 时必须重新运行 App Server、历史恢复、审批、命令、文件修改和终端相关测试。
