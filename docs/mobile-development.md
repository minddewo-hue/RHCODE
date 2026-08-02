# RHZYCODE 移动端开发

移动应用使用 Expo / React Native。桌面是权威服务端，手机只通过中转后的 RHZYCODE HTTP/WebSocket 协议读取状态和提交命令。

## 技术栈

当前精确版本以 `mobile/package.json` 为准：

- Expo 57
- React Native 0.86
- React 19
- TypeScript 严格模式
- `expo-secure-store` 保存连接 KEY
- Android/iOS 包标识见 `mobile/app.json`

## 职责与边界

移动端负责：

- 保存多台电脑的连接元数据和独立 KEY。
- 加载 snapshot、消费事件回放并处理断线重连。
- 展示项目、对话、消息、Activity、审批和结构化输入。
- 新建/打开对话、发送/中断任务、切换模型和推理强度。
- 浏览并登记电脑已有目录，管理对话生命周期。
- 选择图片/文件、上传受限附件、查看和保存生成文件。
- Android APK 更新和 iOS App Store 更新跳转。

移动端不直接调用 Codex、Provider 或桌面局域网端口，不持有 Provider API Key，也不自行扩展协议枚举。

## 目录

```text
mobile/src/
  App.tsx                         应用导航、主题和顶层工作流
  api/control-client.ts          HTTP/WS、认证与响应校验
  api/control-connection-model.ts 连接模型和 endpoint 规则
  auth/control-access.ts         KEY 解析与访问验证
  hooks/use-control-plane.ts     snapshot、事件流和命令状态
  state/control-reducer.ts       AgentEvent 幂等合并
  state/project-list.ts          项目和对话筛选
  storage/secure-session.ts      多电脑 SecureStore 持久化
  components/AppDrawer.tsx       项目、对话、电脑和设置
  components/ChatScreen.tsx      消息、Activity 和输入区
  components/TaskSheets.tsx      项目与对话操作 sheet
  platform/update/               Android/iOS 更新状态机
  ui/theme.ts                    浅色/夜间主题 token
mobile/plugins/                  Expo 平台配置
mobile/test/                     Node 测试
```

共享控制协议以 `packages/protocol` 为准；更新清单以 `packages/update-contract` 为准。

## 启动与验证

```powershell
npm install
npm run typecheck --workspace @rhzycode/mobile
npm test --workspace @rhzycode/mobile
npm run dev:mobile
```

Android 真机或模拟器：

```powershell
adb reverse tcp:8081 tcp:8081
npm run android --workspace @rhzycode/mobile
```

iOS 必须在 macOS/Xcode 环境运行：

```bash
npm run dev:ios
```

自建中转：

```powershell
$env:EXPO_PUBLIC_TRANSFER_SERVER_URL = "https://relay.example.com"
npm run dev:mobile
```

`EXPO_PUBLIC_*` 会进入客户端包，只能放公开 origin，不能放 KEY 或凭据。

## 连接存储

添加电脑只输入桌面生成的 `rhzy_...` KEY。移动端先用 snapshot 验证，再将电脑元数据与 KEY 分开保存：

```text
rhzycode.connections.v2
rhzycode.activeConnectionId.v2
rhzycode.connectionKey.v2.<connection-id>
```

- 电脑元数据不得包含 KEY。
- 每台电脑使用独立 SecureStore 键。
- 旧 host/port 连接数据在首次加载时迁移为 relay-only 模型。
- KEY 轮换后旧 HTTP 返回 `401`，旧 WebSocket 以 `4001` 关闭；客户端要求重新配置。

## 状态同步

```text
GET /v1/snapshot
  -> validate ControlSnapshot
  -> store lastSequence
  -> WS /v1/events?after=<lastSequence>
  -> validate and apply AgentEvent
```

要求：

- 每台电脑维护独立 snapshot、sequence、WebSocket 和重连计时器。
- sequence 只能前进；重复事件按 upsert/idempotent 语义处理。
- 应用进入后台时停止实时连接，回到前台后重新同步。
- socket 存活但可能漏事件时先 resync，不能仅依赖连接状态。
- 历史加载和实时事件必须合并，短 snapshot 不能删除已加载回复。
- 无效 JSON 或 schema 不匹配时拒绝数据并重建连接。

## 命令

完整路由和 schema 以控制面代码为准。移动端当前工作流包括：

- 项目列表、目录浏览、登记和移除。
- 模型目录、线程详情和归档列表。
- 新建线程、发送/中断 Turn、切换线程模型、压缩上下文。
- 提交审批和结构化回答。
- 重命名、归档、恢复和永久删除。
- 受控附件上传、生成图片和文件下载。

所有写命令使用 8-200 字符 `Idempotency-Key`。重试必须复用同一个 key 和请求体；冲突或业务拒绝不能自动变成新命令。

## 错误处理

| 状态 | 行为 |
| --- | --- |
| `400` | 显示输入错误，不重试写操作 |
| `401` | KEY 已失效，进入重新配置 |
| `403` | 显示权限拒绝 |
| `404` | 刷新状态并提示目标不存在 |
| `409` | 显示冲突，刷新后由用户决定 |
| `503` | 桌面离线，保留本地导航并退避重连 |
| 网络超时 | 对幂等请求按既定策略重试 |
| schema 错误 | 拒绝响应，显示服务不兼容 |

## 主题与 UI

- 使用 `createThemedStyles` 和 `ThemeColors`，不要在组件中保存主题创建时的静态颜色。
- 实心按钮使用 `solid/onSolid`；数字徽标使用专用高对比 token。
- 预览浮层使用预览专用颜色，不复用页面背景色。
- 图标按钮应使用现有 Feather/Ionicons 图标并提供 accessibility label。
- 固定工具栏、徽标和按钮尺寸，避免数字、加载状态或长文本引起布局跳动。
- 修改聊天、Activity、抽屉或 sheet 后检查 Android/iOS、浅色/夜间、窄屏和系统字体缩放。

## 平台更新

- Android 读取统一清单，下载 APK，校验大小与 SHA-256，再打开系统安装器。
- iOS 只打开清单中的 App Store URL，不在应用内下载 IPA。
- 当前 Android 发布配置使用公网 HTTP，因此 config plugin 明确允许 cleartext；迁移 HTTPS 后应移除该例外。

## 交付检查

- [ ] `typecheck` 和移动测试通过。
- [ ] snapshot、历史和实时回复在重连后不丢失。
- [ ] 多电脑切换不混合项目、线程、模型或审批。
- [ ] KEY 不在 URL、普通存储、日志或错误文本中。
- [ ] 写命令 key、重试和冲突行为正确。
- [ ] 浅色/夜间的文字、图标、徽标和按钮对比度清晰。
- [ ] Android/iOS 真机验证附件、前后台、弱网和更新流程。
