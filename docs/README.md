# RHZYCODE 文档索引

本文档是项目文档的统一入口。实现发生变化时，优先更新对应的事实来源和一份主文档，避免在多处复制易过期的版本、接口或命令。

## 阅读路径

| 目标 | 文档 |
| --- | --- |
| 了解系统组成和安全边界 | [系统架构](architecture.md) |
| 判断代码应该放在哪里 | [项目结构与依赖边界](project-structure.md) |
| 开发桌面应用 | [桌面端开发](desktop-development.md) |
| 排查删除对话后输入框失焦 | [删除对话焦点故障复盘](desktop-conversation-delete-focus-incident.md) |
| 开发 Android/iOS 应用 | [移动端开发](mobile-development.md) |
| 理解 KEY、快照、事件流和中转 | [移动连接](mobile-connection.md) |
| 协调桌面与移动并行开发 | [并行开发约定](parallel-development.md) |
| 构建和签名桌面/移动产物 | [发布流程](release.md) |
| 暂存、部署和验证升级包 | [更新系统](update-system.md) |
| 准备 macOS/iOS 分发 | [Apple 平台](apple-platforms.md) |
| 查看当前交付状态和剩余门禁 | [路线图](roadmap.md) |
| 执行模型可用性验证 | [模型稳定性](model-stability.md) |
| 查看 Gemma 31B 历史验证 | [Gemma 31B 验证记录](gemma31b-validation.md) |

服务和组件还有就近说明：

- [中转服务运维](../transferserver/README.md)
- [更新脚本说明](../appupdate/README.md)
- [模型网关说明](../desktop/model-gateway/README.md)

## 事实来源

| 信息 | 唯一事实来源 |
| --- | --- |
| npm 命令、依赖、应用版本 | 对应 `package.json` |
| Android/iOS 应用版本 | `mobile/app.json` |
| Android 原生生成配置 | `mobile/android/`，由 Expo prebuild 生成 |
| 内置 Codex CLI 版本 | `desktop/codex-version.json` |
| 桌面 IPC | `desktop/src/shared/desktop-api.ts`、preload 和 main 注册 |
| 移动 HTTP/WS 协议 | `packages/protocol/src/index.ts`、`desktop/src/main/control-plane/app.ts` |
| 更新清单 schema | `packages/update-contract` |
| 公网已发布版本 | 中转服务 `/v1/updates/manifest` |
| 发布地址和远程目录 | `appupdate/config.json` |
| 模型路由和禁用列表 | `desktop/gateway.config.json` |

文档可以解释这些事实，但不应维护第二套相互独立的数字或枚举。

## 文档类型

- 规范文档：架构、项目结构、开发、连接、发布和运维。必须与当前代码同步。
- 状态文档：路线图。记录当前门禁和近期工作，不作为接口定义。
- 历史报告：模型稳定性和 Gemma 验证。结论只代表报告日期；当前模型状态以网关配置和重新测试结果为准。

## 更新要求

修改以下内容时必须同步文档：

- 协议、状态码、认证、KEY 生命周期或事件类型。
- 环境变量、构建命令、发布目录或远程部署方式。
- 应用版本来源、Codex 固定版本或签名门禁。
- 平台支持范围、安全边界或数据持久化行为。

提交前检查 Markdown 链接、代码块命令和路径均能在当前仓库中找到。不要在文档中写入真实密钥、认证 header、私有证书路径或用户数据。
