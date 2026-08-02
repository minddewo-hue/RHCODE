# 桌面与移动连接

## 连接模型

RHZYCODE 使用 relay-only 连接。桌面和手机都连接同一个中转 origin，手机添加电脑时只填写桌面生成的长期 KEY。

```text
Desktop -- outbound WS registration --> Transfer Server
Mobile  -- HTTP/WS + KEY ------------> Transfer Server
Transfer Server -- live forwarding --> online Desktop
```

- 中转只在内存中保存 KEY 摘要和在线 socket。
- 不保存原始 KEY、请求、事件、附件或离线队列。
- 对应桌面不在线时返回 `503 desktop_offline`。
- 桌面应用不依赖中转也可以完成本地任务。

默认 origin 见 `appupdate/config.json` 和客户端配置。自建部署使用：

```text
Desktop: RHZYCODE_TRANSFER_SERVER_URL
Mobile:  EXPO_PUBLIC_TRANSFER_SERVER_URL
```

两端必须指向同一个 origin。

## 桌面边界

桌面控制面只绑定 `127.0.0.1` 的随机端口。只有桌面 relay client 可以访问该端口；UI 中没有 host/port 设置，旧 `RHZYCODE_SYNC_HOST` 和 `RHZYCODE_SYNC_PORT` 不再生效。

不要把控制面改为 `0.0.0.0`、局域网地址或公网监听，也不要为手机配置端口映射。

## 认证

HTTP：

```http
Authorization: Bearer <desktop-access-key>
```

WebSocket：

```text
rhzycode.v1
rhzycode.auth.<desktop-access-key>
```

KEY 不放在 URL 或 query 中。桌面重新生成 KEY 后：

- 旧 HTTP 请求返回 `401`。
- 已连接的旧 WebSocket 以 `4001` 主动关闭。
- 桌面用新 KEY 重新注册中转。
- 手机必须重新录入新 KEY。

## 同步流程

1. 手机携带 Bearer KEY 获取 `/v1/snapshot`。
2. 运行时校验 `ControlSnapshot`，记录 `lastSequence`。
3. 使用 `after=lastSequence` 建立 `/v1/events` WebSocket。
4. 按 sequence 单调应用事件，重复事件按 ID/upsert 处理。
5. 前后台切换、断线或疑似漏事件时重新获取 snapshot。

持久化事件可以回放，但 sequence 不保证连续，因为待审批、待输入等非耐久状态不会跨桌面重启恢复。

## 稳定协议摘要

核心读取接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/snapshot` | 完整控制状态 |
| `GET` WS | `/v1/events?after=N` | 回放与实时事件 |
| `GET` | `/v1/generated-images/:id` | 受控生成图片 |
| `GET` | `/v1/files/:id` | 受控文件下载 |

远程命令位于 `/v1/commands/*`，包括项目、模型、线程、Turn、上下文压缩和结构化输入。审批使用 `/v1/approvals/:id`。完整 schema 以 `packages/protocol/src/index.ts` 为准，完整路由以 `desktop/src/main/control-plane/app.ts` 为准。

共享事件类型：

- `host.status`
- `thread.updated`
- `thread.removed`
- `timeline.upserted`
- `approval.requested` / `approval.resolved`
- `user_input.requested` / `user_input.resolved`

## 幂等与状态码

所有远程写命令携带 `Idempotency-Key`。相同 key 和相同请求可返回缓存结果；不同请求复用 key 返回 `409`。

| 状态 | 含义 |
| --- | --- |
| `400` | 请求结构或参数无效 |
| `401` | KEY 无效或已轮换 |
| `403` | 移动身份不允许该操作 |
| `404` | 资源不存在或能力未启用 |
| `409` | 状态冲突或幂等 key 冲突 |
| `503` | 桌面或 Agent 当前不可用 |

HTTP 成功不替代事件同步。客户端最终以 snapshot 和 WSS 事件为权威状态，不能仅根据命令响应伪造线程或消息。

## 明文公网风险

当前默认公网部署使用 HTTP/WS。它不会加密 KEY、提示词、回复、文件或命令；中转不落盘并不能防止链路窃听或篡改。

生产部署应使用可信 HTTPS/WSS，限制 Host/Origin，关闭代理正文日志，并保护中转主机和运维权限。部署细节见 [中转服务 README](../transferserver/README.md)。
