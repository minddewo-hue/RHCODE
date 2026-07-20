# 桌面端与手机端并行开发约定

更新日期：2026-07-15

本文是两个独立开发任务的入口。桌面端任务先阅读 `docs/desktop-development.md`，手机端任务先阅读 `docs/mobile-development.md`。两端可以同时开发，但必须遵守下面的目录所有权和接口冻结规则。

## 1. 任务拆分

| 任务 | 主要负责 | 默认只读 |
| --- | --- | --- |
| 桌面端 | `desktop/**`、`services/control-plane/**`、桌面发行与本地 Agent Host | `mobile/**` |
| 手机端 | `mobile/**`、移动端交互、真机连接与 SecureStore | `desktop/**`、`services/control-plane/**` |

`packages/protocol/**`、根 `package.json`、`package-lock.json` 和 `docs/**` 是共享区域。共享区域不能由两个任务同时修改。需要变更协议时，手机端任务先记录所需字段和行为，由桌面端/控制面任务更新 schema 与服务端实现；手机端随后消费已经通过测试的新协议。

项目当前不是 Git 仓库。如果两个开发任务直接使用同一个目录，只能编辑上表中的独占目录。涉及共享文件、安装依赖、根构建或发行打包时必须暂停另一任务的写操作。更强的隔离方式是给两个任务复制独立工作目录，并在人工审查后合并。

## 2. 当前冻结接口

以下接口是两端联调基线。未经同步确认，不应单方面改名或改变语义。

### 移动连接

- 手机输入桌面 Settings 显示的 LAN IP、端口和 `rhzy_...` 长期 KEY。
- KEY 由桌面自动生成并通过 DPAPI 加密保存，手动重新生成前持续有效。
- 手机通过 SecureStore 保存 host、port 和 accessKey。

### 鉴权和传输

- HTTP：`Authorization: Bearer <KEY>`
- WebSocket：子协议同时发送 `rhzycode.v1` 和 `rhzycode.auth.<KEY>`
- 快照：`GET /v1/snapshot`
- 事件：`GET /v1/events?after=<lastSequence>`，通过 WebSocket 推送
- 审批：`POST /v1/approvals/:id`，请求体为 `{ "decision": "approved" | "declined" }`
- 健康检查：`GET /health` 不要求 KEY。
- 桌面默认监听 `0.0.0.0:8790`，可信局域网使用 HTTP/WS；托管部署可配置 HTTPS/WSS。
- 桌面重新生成 KEY 时，现有 WSS 以关闭码 `4001` 主动关闭；旧 KEY 的后续 HTTP 和 WSS 重连返回 `401`。

### 远程任务命令

以下路由只在桌面内嵌控制面可用，均要求 Bearer KEY；除只读归档列表外，写命令还要求 `Idempotency-Key`：

| 方法和路由 | 请求 | 成功 |
| --- | --- | --- |
| `POST /v1/commands/threads/start` | `projectPath`，可选 `model/approvalPolicy/sandboxMode` | `201 { threadId, acceptedAt }` |
| `POST /v1/commands/threads/:threadId/turns/start` | `text`，可选 `approvalPolicy/sandboxMode` | `202 { threadId, turnId, acceptedAt }` |
| `POST /v1/commands/threads/:threadId/turns/interrupt` | 空对象 | `202 { threadId, acceptedAt }` |
| `GET /v1/commands/threads/archived` | 可选 query `searchTerm` | `200 { threads }`，不要求幂等键 |
| `POST /v1/commands/user-inputs/:requestId/submit` | `{answers: Record<string,string[]>}` | `202 { requestId, acceptedAt }` |
| `POST /v1/commands/threads/:threadId/rename` | `{name}` | `200 { threadId, acceptedAt }` |
| `POST /v1/commands/threads/:threadId/archive` | 空对象 | `200 { threadId, acceptedAt }` |
| `POST /v1/commands/threads/:threadId/unarchive` | 空对象 | `200 { threadId, acceptedAt }` |
| `DELETE /v1/commands/threads/:threadId` | 空对象 | `200 { threadId, acceptedAt }` |

- 写命令的 `Idempotency-Key` 为 8-200 位字母、数字或 `._:-`；同设备同 key 的相同请求在十分钟内返回同一结果，不重复执行，不同请求复用 key 返回 `409`。
- 远程策略只允许 `approvalPolicy=on-request|untrusted` 和 `sandboxMode=read-only|workspace-write`；缺省为 `on-request + read-only`。
- 不支持远程 `danger-full-access`、`never` 或附件路径；跨设备附件必须另行设计上传协议。
- `projectPath` 必须来自桌面已知线程，未知项目返回 `404`。线程忙、无活跃 Turn 或 key 冲突返回 `409`，Agent 不可用返回 `503`。
- 结构化答案只交给当前待处理 App Server RPC；答案值不进入事件、审计或持久化。归档列表实时查询 App Server 且不进入活动 snapshot。
- 活跃、待审批或待输入线程不能远程归档或永久删除；删除不可恢复，成功审计只记录 thread ID。
- HTTP 成功只表示桌面 App Server 已接受命令。手机随后以桌面 `thread.updated`、`timeline.upserted` 和 snapshot/WSS 序列为权威结果，不在本地先行伪造业务状态。

### 协议类型

`packages/protocol/src/index.ts` 是共享数据契约的唯一来源。目前事件类型为：

- `host.status`
- `thread.updated`
- `thread.removed`
- `timeline.upserted`
- `approval.requested`
- `approval.resolved`
- `user_input.requested`
- `user_input.resolved`

新增或修改事件时，必须同时完成 schema、控制面存储/回放、桌面映射、手机端 reducer 和兼容性测试。

## 3. 并行运行

桌面端任务：

```powershell
cd D:\work_space\test
npm run dev:desktop
```

默认地址：

- Renderer：`http://localhost:5173`
- Control Plane：`http://127.0.0.1:8790`

手机端任务：

```powershell
cd D:\work_space\test
$env:EXPO_PUBLIC_CONTROL_URL = "http://127.0.0.1:8790"
npm run dev:mobile
```

Android 模拟器访问宿主机时通常不能使用自己的 `127.0.0.1`。应使用模拟器提供的宿主机地址，或通过受信任 HTTPS/WSS 配置连接实际局域网地址。以 Expo 输出和当前模拟器网络规则为准。

两个任务可以同时运行各自的开发服务器。不要同时执行 `npm install`、根 `npm run build`、`npm run dist:desktop`，也不要同时修改或清理 `node_modules`、workspace `dist`、`desktop/out`、`desktop/release`。

## 4. 合并门禁

每个任务交付前至少完成：

```powershell
npm run typecheck --workspace @rhzycode/desktop
npm test --workspace @rhzycode/desktop
npm run typecheck --workspace @rhzycode/mobile
npm run typecheck --workspace @rhzycode/control-plane
npm test --workspace @rhzycode/control-plane
```

共享集成完成后由一个任务串行执行：

```powershell
npm run check
npm run smoke:mobile-access --workspace @rhzycode/desktop
npm run dist:desktop
```

发行审计仍需确认安装包不包含 `.env`、`auth.json`、`config.toml`、Provider Key、移动 KEY、DPAPI 状态文件、PEM/PFX 私钥或测试证书。

## 5. 冲突处理

1. 手机端需要新接口时，不直接在手机端伪造响应字段；先提交契约需求。
2. 桌面端改变控制面响应时，必须保留旧字段或同步更新手机端任务，并更新两份开发文档。
3. 两端都需要新增 npm 依赖时，由一个任务统一安装并提交 lockfile 变更，另一任务等待完成。
4. 两端对同一行为理解不一致时，以 `packages/protocol` schema、控制面测试和本文冻结接口为准。
5. 不读取、输出或提交 `.env`、默认 Codex `auth.json`、API Key、移动 KEY、证书私钥。

## 6. 当前外部依赖

代码层的长期 KEY 鉴权、LAN/HTTPS 传输、事件回放和移动端 SecureStore 已完成。正式跨设备部署仍需要：

- Windows 代码签名证书；
- 正式自动更新服务器；
- 手机信任的控制面 TLS 证书；
- 可达的局域网地址、防火墙策略，或可信出站中继。
