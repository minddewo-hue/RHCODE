# RHZYCODE 交付路线图

更新日期：2026-07-30

本文档记录当前交付状态和外部门禁，不定义接口。接口与行为以代码、测试和对应规范文档为准。

## 已完成

### 桌面工作区

- 应用私有 Codex Home 和固定 Codex CLI 打包。
- 项目目录、对话搜索、恢复、重命名、归档、删除和上下文压缩。
- 多线程并发 Turn、后台状态隔离和启动恢复。
- 流式回复、Activity、命令、文件变更、审批、结构化输入和中断。
- 图片/文件附件、生成文件、对话导入导出和内置终端。
- Provider 凭据安全存储、模型目录、健康检查和动态配置。
- 浅色/夜间主题、窄窗口布局和 Electron UI 自动化。

### 移动控制

- 桌面生成长期 KEY，多电脑 SecureStore 隔离。
- 桌面出站中转注册，手机 relay-only 连接。
- snapshot、事件回放、前后台恢复和弱网重连。
- 对话、项目、模型、Turn、审批和结构化输入控制。
- 历史回复保留、丢失响应重放和幂等写命令。
- 图片/文件附件、生成文件查看与下载。
- Android/iOS 浅色和夜间主题。

### 中转与更新

- 无状态在线路由，不保存原始 KEY、任务或离线队列。
- 请求/事件转发、认证失败限流和资源上限。
- Windows/Android 统一更新清单与静态文件服务。
- 本地暂存、SSH 上传和原子切换远程清单。
- Windows release 审计、敏感文件扫描和哈希清单。

## 当前交付状态

| 平台 | 代码状态 | 正式分发门禁 |
| --- | --- | --- |
| Windows | 可构建、安装、自动更新 | 生产 Authenticode 证书 |
| Android | 可构建、安装、应用内更新 | 生产 Android keystore、HTTPS |
| macOS | 平台适配和 DMG/ZIP 构建入口已实现 | macOS 构建机、Developer ID、公证、更新 feed |
| iOS | Expo/Xcode archive 入口已实现 | App Store 配置、签名、TestFlight、清单接入 |

版本号不在路线图重复维护；事实来源见 [文档索引](README.md#事实来源)。

## 最高优先级

1. 将公网中转和更新地址迁移到可信 HTTPS/WSS。
2. 配置 Windows Authenticode 和 Android 生产 keystore，强制正式发布签名。
3. 增加签名安装包的全新安装、覆盖升级和回滚验收。
4. 关闭迁移 HTTPS 后不再需要的 Android/iOS cleartext 例外。

## Apple 平台

1. 准备 macOS x64/arm64 构建主机和对应 Codex 二进制。
2. 完成 Developer ID、notarization、Gatekeeper 与 macOS 自动更新。
3. 完成 App Store Connect、TestFlight 和 iOS 真机升级验证。
4. 扩展 update contract、publisher 和中转路由以支持 macOS/iOS。

## 工程维护

- 恢复或迁移 `model-stability-matrix.ts` 依赖的验证 fixture；当前脚本引用的 `validation/a-share-compute-assistant` 已不存在。
- 重新运行模型矩阵后生成新的带日期报告，避免沿用 2026-07-17 的上游状态。
- 为 Markdown 增加链接、路径、脚本名和过期版本引用检查。
- 持续扩大历史恢复、弱网、附件和深浅主题的端到端覆盖。

## 未来范围

以下能力不属于当前桌面在线中转版本：

- 离线任务队列和桌面离线执行。
- 云端隔离 worker、仓库镜像和持久任务。
- 团队角色、组织策略、配额、计费和集中审计。
- 端到端加密中转或零知识文件服务。

引入这些能力需要独立架构设计，不能通过给当前无状态中转增加少量字段实现。

## 验证基线

```powershell
npm run check
npm run build
npm run test:ui --workspace @rhzycode/desktop
npm test --workspace @rhzycode/transferserver
```

真实 Agent、平台签名和发布验证按 [桌面开发](desktop-development.md)、[移动开发](mobile-development.md) 和 [发布流程](release.md) 执行。
