# RHZYCODE 移动端开发文档

本文档描述当前 Expo 移动端。桌面应用是唯一权威服务端，手机只通过稳定的 RHZYCODE HTTP/WebSocket 接口读取状态和提交命令。

## 1. 技术栈与边界

| 项目 | 当前值 |
| --- | --- |
| Expo | 57 |
| React Native | 0.86 |
| React | 19.2 |
| TypeScript | 严格模式 |
| Android 包名 | `ai.rhzy.code` |
| iOS Bundle ID | `ai.rhzy.code` |
| 安全存储 | `expo-secure-store` |

移动端负责：

- 输入并安全保存多台桌面的 IP、端口和长期 KEY，每台电脑使用独立凭据。
- 加载完整 `ControlSnapshot`，通过 WebSocket 回放和接收增量事件。
- 展示电脑、对话、消息、审批和结构化用户输入。
- 创建对话、发送消息、中断任务、提交回答。
- 搜索、重命名、归档、恢复和删除对话。
- 从当前电脑读取可用模型，并为新任务或下一轮消息切换模型。
- 同步并打开电脑上已经存在的工程目录，不通过手机端创建文件夹。
- 在前后台切换、断线和桌面重启后自动恢复。
- 同时维持所有已保存电脑的事件连接，并在当前电脑之间即时切换，任务数据互不混合。

移动端不直接调用 Codex App Server，不持有 Provider 凭据，也不解释 Codex 私有 RPC。

## 2. 目录

```text
mobile/src/
  App.tsx                       应用状态和用户工作流
  api/control-client.ts        HTTP、WebSocket 描述和运行时响应校验
  auth/control-access.ts       IP、端口和 KEY 规范化
  hooks/use-control-plane.ts   snapshot、事件流、重连和审批操作
  state/control-reducer.ts     AgentEvent 合并
  storage/secure-session.ts    安全会话存储抽象
  storage/native-secure-session.ts
  components/AppDrawer.tsx     对话、电脑、连接和设置侧栏
  components/ChatScreen.tsx    消息、审批、输入请求和发送区
  components/TaskSheets.tsx    新建任务和对话操作
  ui/theme.ts                  视觉变量
mobile/test/                   Node 单元和接口测试
```

共享类型的事实来源是 `packages/protocol/src/index.ts`。控制接口的事实来源是 `desktop/src/main/control-plane/app.ts`。

## 3. 启动与验证

```powershell
npm install
npm run typecheck --workspace @rhzycode/mobile
npm test --workspace @rhzycode/mobile
npm run dev:mobile
```

Android：

```powershell
adb reverse tcp:8081 tcp:8081
adb reverse tcp:8790 tcp:8790
npm run android --workspace @rhzycode/mobile
```

物理手机也可以直接访问桌面显示的 WLAN 地址，不需要 ADB reverse。桌面和手机必须处于同一可信局域网。

可选开发默认值：

```powershell
$env:EXPO_PUBLIC_CONTROL_HOST = "192.168.11.103"
$env:EXPO_PUBLIC_CONTROL_PORT = "8790"
npm run dev:mobile
```

公开构建变量只能包含 IP/主机名和端口，绝不能包含 KEY。

## 4. 多电脑长期 KEY 连接

添加每台电脑时只需要三个字段：

1. 桌面显示的本机 IP 地址，例如 `192.168.11.103`。
2. 桌面控制端口，默认 `8790`。
3. 桌面生成的 `rhzy_...` 长期 KEY。

连接前，移动端使用 `GET /v1/snapshot` 验证 KEY。验证成功后，SecureStore 保存电脑元数据、当前电脑 ID，并按连接 ID 分开保存 KEY：

```text
rhzycode.connections.v2
rhzycode.activeConnectionId.v2
rhzycode.connectionKey.v2.<connection-id>
```

旧版本的 `rhzycode.controlHost`、`rhzycode.controlPort` 和 `rhzycode.accessKey` 会在首次启动时自动迁移。主聊天页只显示当前电脑的对话；其他电脑仍在后台保持 WebSocket 同步，可从“设置 > 电脑”查看状态并切换。

KEY 在桌面手动重新生成前长期有效。桌面重新生成 KEY 后，旧 HTTP 请求返回 `401`，旧 WebSocket 以代码 `4001` 关闭；移动端进入需要重新配置的状态并清除本机 KEY。

HTTP 认证：

```http
Authorization: Bearer <desktop-access-key>
```

WebSocket 认证：

```text
rhzycode.v1
rhzycode.auth.<desktop-access-key>
```

KEY 不进入 URL、日志、错误信息、事件或普通 React Native 存储。

## 5. 状态同步

连接顺序：

```text
GET /v1/snapshot
  -> 保存 lastSequence
  -> WS /v1/events?after=<lastSequence>
  -> applyAgentEvent
```

`useControlPlane` 为每台已保存电脑维护独立 snapshot、sequence、WebSocket 和重连计时器。应用进入后台时关闭全部连接，回到前台后分别重新获取 snapshot。普通断线使用带抖动的指数退避，范围从约 1 秒到 30 秒。手工刷新只刷新当前电脑，并在 WebSocket 未打开时触发重连。

收到无效 JSON 或不符合 `agentEventSchema` 的事件时，不应用该事件并重建连接。sequence 只能前进，重复删除和已处理审批必须保持幂等。

## 6. 控制接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/snapshot` | 完整状态 |
| `GET` WS | `/v1/events?after=N` | 事件回放和实时更新 |
| `POST` | `/v1/approvals/:id` | 批准或拒绝 |
| `GET` | `/v1/commands/projects` | 列出电脑端已登记工程目录 |
| `GET` | `/v1/commands/models` | 读取当前电脑可用模型 |
| `POST` | `/v1/commands/projects` | 打开并登记电脑端已有工程目录 |
| `GET` | `/v1/commands/threads/archived` | 归档列表 |
| `POST` | `/v1/commands/threads/start` | 新建对话 |
| `POST` | `/v1/commands/threads/:id/turns/start` | 发送消息 |
| `POST` | `/v1/commands/threads/:id/turns/interrupt` | 中断任务 |
| `POST` | `/v1/commands/user-inputs/:id/submit` | 提交结构化回答 |
| `POST` | `/v1/commands/threads/:id/rename` | 重命名 |
| `POST` | `/v1/commands/threads/:id/archive` | 归档 |
| `POST` | `/v1/commands/threads/:id/unarchive` | 恢复 |
| `DELETE` | `/v1/commands/threads/:id` | 永久删除 |

所有写命令都必须携带唯一 `Idempotency-Key`。移动端只允许服务端协议声明的 sandbox 和 approval policy，不能请求 `danger-full-access` 或 `never`。

模型切换遵循桌面端相同行为：模型目录由当前电脑动态返回，选择结果用于新任务或下一轮 `turn/start`。任务处于运行中时不能切换；不同电脑分别使用各自的模型目录和当前选择。

工程目录由桌面端统一管理并加密持久化。手机端“打开工程”时提交电脑上已有目录的绝对路径，桌面端只登记并同步到桌面与手机的项目菜单，不创建新文件夹。不存在的路径、相对路径、磁盘根目录和指向普通文件的路径会被拒绝。

## 7. 错误状态

| 状态 | 移动端行为 |
| --- | --- |
| `400` | 显示输入或命令无效，不重试写操作 |
| `401` | 清除 KEY，打开连接设置 |
| `403` | 显示操作被拒绝 |
| `404` | 刷新状态，提示目标已不存在 |
| `409` | 显示状态冲突，刷新后由用户决定 |
| 超时/离线 | 保留会话，指数退避重连 |
| 响应 schema 无效 | 拒绝数据并显示服务异常 |

## 8. Android 网络

本地 IP 通常没有手机信任的证书，因此开发和可信局域网使用 HTTP/WS。`with-private-network-cleartext.cjs` 只为 Android 应用声明 cleartext 能力；KEY 仍是所有业务请求的认证边界。

不要把桌面 `8790` 端口映射到公网。远程部署必须增加可信 HTTPS/WSS、可达地址和网络策略。

## 9. 交付检查

- [ ] 三字段连接只接受私有 IP/本地主机、有效端口和 `rhzy_` KEY。
- [ ] SecureStore 中电脑元数据不含 KEY，每台电脑的 KEY 使用独立安全存储键。
- [ ] 多台电脑同时在线时各自保持 WebSocket，切换电脑不会混合对话、项目或审批。
- [ ] snapshot 和全部事件类型有运行时校验。
- [ ] HTTP KEY 只在 Bearer header，WebSocket KEY 只在 subprotocol。
- [ ] 401、4001、离线和前后台切换均能恢复到正确状态。
- [ ] 写命令带 `Idempotency-Key`，失败时不会静默重复执行。
- [ ] TypeScript、移动端测试、Android bundle 和真机布局验证通过。
