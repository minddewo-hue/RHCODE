# RHZYCODE Transfer Server

`transferserver` 是桌面与移动之间的无状态中转服务，同时提供统一更新清单和安装包下载。

## 工作方式

1. 桌面用自己生成的 `rhzy_...` KEY 建立出站 WebSocket 注册。
2. 服务在内存中保存 KEY 的 SHA-256 摘要和当前桌面 socket，不保存原始 KEY。
3. 手机通过 `/control/v1/*` 携带同一个 KEY 发起 HTTP/WebSocket 请求。
4. 服务把请求实时转给在线桌面；桌面离线返回 `503 desktop_offline`。
5. `/v1/updates/manifest` 校验并返回 `updates/version.json`；`/updates/*` 提供安装包。

服务没有用户库、设备库、KEY 文件、任务持久化或离线队列。进程退出会清空在线映射和等待请求。

## 启动

```powershell
npm run transfer:serve
```

也可以直接运行 workspace：

```powershell
npm start --workspace @rhzycode/transferserver
```

## 配置

参考 `.env.example`：

| 变量 | 用途 |
| --- | --- |
| `RHZYCODE_TRANSFER_HOST` | Node 监听地址 |
| `RHZYCODE_TRANSFER_PORT` | Node 监听端口 |
| `RHZYCODE_TRANSFER_TRUST_PROXY` | 是否信任反向代理信息 |
| `RHZYCODE_TRANSFER_REQUIRE_TLS` | 是否强制 Node 原生 TLS |
| `RHZYCODE_TRANSFER_ALLOW_PUBLIC_HTTP` | 显式允许公网明文监听 |
| `RHZYCODE_TRANSFER_ALLOWED_HOSTS` | 允许的精确 Host 列表 |
| `RHZYCODE_TRANSFER_ALLOWED_ORIGINS` | 允许的精确 Origin 列表 |
| `RHZYCODE_TRANSFER_TLS_CERT` | TLS 证书路径 |
| `RHZYCODE_TRANSFER_TLS_KEY` | TLS 私钥路径 |
| `RHZYCODE_TRANSFER_UPDATES_DIR` | 更新文件目录 |

桌面和移动必须使用同一个公网 origin：

```text
RHZYCODE_TRANSFER_SERVER_URL
EXPO_PUBLIC_TRANSFER_SERVER_URL
```

## 部署模式

### 当前明文部署

当前项目配置在公网 `8000` 直接运行 HTTP/WS，并显式设置 `RHZYCODE_TRANSFER_ALLOW_PUBLIC_HTTP=1`。该模式不会加密 KEY、提示词、回复或文件，仅适合已接受该风险的受控部署。

### 推荐 TLS 部署

推荐由 Nginx 在公网终止 TLS，Node 只监听 `127.0.0.1` 私有端口。模板位于：

```text
transferserver/deploy/nginx-8000.conf
transferserver/deploy/rhzy-transfer-proxy.conf
transferserver/deploy/rhzycode-transfer.service
```

也可配置 `RHZYCODE_TRANSFER_TLS_CERT` / `RHZYCODE_TRANSFER_TLS_KEY` 让 Node 直接终止 TLS。私钥权限应为 `0600`，并关闭 `ALLOW_PUBLIC_HTTP`。

不要在 Nginx、CDN、WAF 或 APM 中记录 `Authorization`、`Sec-WebSocket-Protocol`、请求体或响应体。

## 网络与资源限制

- 公网只开放服务端口；Node 私有端口不得加入安全组。
- SSH 只允许固定管理来源并使用密钥认证。
- 请求、隧道 frame、每桌面并发和全局连接都有硬上限。
- 服务对 KEY 摘要、来源 IP 和认证失败执行限流。
- 每 30 秒探测桌面连接并清理失活注册。
- 更新清单限制大小，文件读取拒绝路径穿越和符号链接。
- 安装包支持受限 Range 请求。

具体默认值以 `server.mjs`、`app.mjs` 和 `.env.example` 为准，不在文档复制易过期数字。

## 更新文件

目录布局和远程部署由 [更新系统](../docs/update-system.md) 定义。服务代码未变化时，上传新安装包不需要重启进程；部署脚本最后原子切换 `version.json`。

## 验证

```powershell
npm test --workspace @rhzycode/transferserver
npm run typecheck --workspace @rhzycode/desktop
npm run typecheck --workspace @rhzycode/mobile
```

从服务所在网络之外执行远程安全检查：

```powershell
npm run audit:remote --workspace @rhzycode/transferserver -- http://218.201.210.211:8000
```

检查更新接口：

```powershell
Invoke-RestMethod http://218.201.210.211:8000/v1/updates/manifest
```

## 安全边界

- 中转在处理请求时能看到转发内容；“不落盘”不等于端到端加密。
- KEY 只出现在认证 header/subprotocol，不进入 URL。
- 反向代理必须禁用正文缓冲和敏感 header 日志。
- 生产主机、SSH、systemd、代理和更新目录按敏感系统管理。
- 正式生产应同时使用 HTTPS/WSS 和平台代码签名。
