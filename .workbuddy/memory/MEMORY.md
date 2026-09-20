# RHZYCODE 项目长期记忆

## 环境（Windows，WorkBuddy 沙箱）
- Git Bash 损坏：coreutils（dirname/cat/head/wc）缺失 → 命令 Exit 127。**一律用 PowerShell 或 Read/Write/Edit/Glob/Grep 工具**。
- PowerShell 控制台输出捕获不稳定（经常空输出）→ 长任务用 `... 2>&1 | Out-File -Encoding utf8 <log>` 写日志，再用 Read/Grep 查看；后台任务用 `run_in_background`。
- 运行时分选：优先 managed 运行时 `C:\Users\Administrator\.workbuddy\binaries\{python,node}\...`。
- 测试：各 workspace `npm test`（tsx --test）；根 `npm run check` = typecheck + 全部 workspace 测试。

## 对话同步契约（Track B 已实施，2026-09-20）
- 排序权威键 `orderKey`（每线程单尺、正文/活动共享、创建即分配并持久化）；`createdAt` 仅展示。排序：`compareTimelineOrder`（同线程双键→orderKey→id；否则 createdAt→id）。
- 身份权威 `logicalId`：去重键 = `threadId + (logicalId || id)`。
- **orderKey 稳定性规则**（`runtime.ts stabilizeThreadDetailKeys`）：单次响应内按键严格按生成序 walk 递增；同一行键跨次只增不减（锚点优先级：上次 threadDetailCache > 本地 rollout；`key = max(计数器+1, 锚点)`）。改这段前必读该函数注释——稀疏 rollout 的位置键**不能**当权威（无插行键位）。
- 增量：`GET /v1/commands/threads/:id/timeline?afterOrderKey=N&limit=K`；响应 `maxOrderKey` = **整次重建**最大键（非当页），mobile 用它检测 scale reset（< 本地游标 → 全量 openThread）。
- gap 恢复：WS 带 `after=lastSequence` 续拉 ≤3 次，才回退全量 snapshot；建连后无额外全量 resync。
- mobile 本地缓存：`mobile/src/storage/timeline-cache.ts`（LRU 20 线程，只存 user/assistant 正文 + maxOrderKey 游标）。
- 方案与实施差异见 `docs/mobile-conversation-sync-improvement.md` §0.1。

## 用户
- 中文环境；偏好：先出方案再动手、按方案分任务实施、改完要全量验证 + 文档回填。
