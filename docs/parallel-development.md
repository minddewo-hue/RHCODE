# 并行开发约定

## 文件所有权

可以独立推进：

```text
Desktop task: desktop/**, docs/desktop-development.md
Mobile task:  mobile/**, docs/mobile-development.md
Relay task:   transferserver/**, transferserver/README.md
Release task: appupdate/**, docs/release.md, docs/update-system.md
```

需要协调：

```text
packages/protocol/**
packages/update-contract/**
package.json
package-lock.json
docs/architecture.md
docs/mobile-connection.md
```

共享文件只能由一个任务在同一时间修改。安装依赖、版本提升和发布也由一个任务串行完成。

## 协议变更顺序

跨端功能按以下顺序推进：

1. 定义当前 schema、状态码和权限边界。
2. 实现桌面权威行为和运行时校验。
3. 更新移动客户端解析、状态与 UI。
4. 更新中转限制或文件转发能力（如需要）。
5. 增加协议、桌面、移动和中转测试。
6. 更新一份主文档并从其他文档链接过去。

手机端不得猜测响应字段；协议字段变更必须在共享 schema、桌面端、手机端和测试中原子完成。

## 并行运行

桌面：

```powershell
$runId = "desktop-$PID"
$env:RHZYCODE_USER_DATA_DIR = Join-Path $env:TEMP "$runId-user-data"
$env:RHZYCODE_CODEX_HOME = Join-Path $env:TEMP "$runId-codex-home"
$env:RHZYCODE_SKIP_ENVIRONMENT_MIGRATION = "1"
npm run dev:desktop
```

移动：

```powershell
$env:EXPO_PUBLIC_TRANSFER_SERVER_URL = "http://218.201.210.211:8000"
npm run dev:mobile
```

任务可以同时运行开发服务器，但不要同时执行：

- `npm install` 或修改根 lockfile。
- 根 `npm run build`。
- Expo prebuild。
- 桌面/移动 release 构建。
- 清理 `node_modules`、`desktop/out`、`desktop/release` 或 Android build 目录。

## 合并门禁

各任务先运行自己的检查：

```powershell
npm run typecheck --workspace @rhzycode/desktop
npm test --workspace @rhzycode/desktop

npm run typecheck --workspace @rhzycode/mobile
npm test --workspace @rhzycode/mobile

npm test --workspace @rhzycode/transferserver
```

共享变更合并后由一个任务串行运行：

```powershell
npm run check
npm run build
```

UI、真实 Agent、平台和发布变更再按对应文档执行 Playwright、冒烟或打包验证。

## 冲突处理

- 已存在的未提交改动默认属于当前开发者，不覆盖、不回滚。
- lockfile 冲突通过一次受控安装重新生成，不手工拼接依赖树。
- 协议理解冲突以 `packages/protocol`、控制面实现和测试为准。
- 文档与代码冲突时先确认实际运行行为，再修正文档；不要为了匹配旧文档改回代码。
- 任何任务都不得读取、输出或提交 `.env`、默认 Codex `auth.json`、API Key、移动 KEY 或签名材料。
