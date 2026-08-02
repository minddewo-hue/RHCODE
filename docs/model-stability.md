# 模型稳定性验证

> 历史快照：下列结果采集于 2026-07-17，不代表当前 Provider 可用性。当前模型和禁用列表以 `desktop/gateway.config.json` 为准。

## 历史结论

当时桌面列出的 26 个模型中，18 个完成了以下验证，8 个在初测和复测中没有建立有效响应：

1. 连续两轮精确短响应。
2. 使用 shell 读取验证项目的 `package.json`。
3. 在隔离副本中创建 JavaScript 模块和 `node:test` 测试。
4. 由本机脚本独立重新运行测试。

代码编辑使用 `danger-full-access`，因此结果只验证模型与工具链能力，不验证较低权限 sandbox。

历史通过范围包括当时配置的 Faker Kimi/MiniMax、VLLM Gemma BF16，以及 Sub2API 5.3 至 5.6 部分模型。历史失败包括已移除的 Faker/VLLM 路由和五个 Sub2API 5.2 路由。

这些结果不能用于当前模型推荐：

- 上游服务状态会变化。
- 当前 `gateway.config.json` 已不再包含 Faker 和 VLLM Provider。
- 当前配置仍保留五个带 2026-07-17 原因的 Sub2API 禁用项。
- 两轮测试不能替代长时间压力测试和生产监控。

## 当前验证脚本

脚本位于 `desktop/scripts/model-stability-matrix.ts`，支持：

```powershell
npm run smoke:models --workspace @rhzycode/desktop
npm run smoke:models:coding --workspace @rhzycode/desktop
```

脚本会把最新结果写入：

```text
validation/model-stability/latest.json
validation/model-stability/workspaces/
```

## 当前阻塞

截至 2026-07-30，脚本要求的 `validation/a-share-compute-assistant` fixture 不在仓库中，因此上述命令会在开始测试前失败。重新测试前必须二选一：

1. 恢复该 fixture；或
2. 将脚本迁移到一个已提交、无敏感数据、可复制的验证项目。

修复后应先运行单个模型，再运行完整矩阵，避免一次并发测试给 Provider 造成不必要负载。

## 新报告要求

重新验证时记录：

- 日期、Codex CLI 版本和网关配置提交。
- Provider 与模型 ID，不记录 API Key。
- 首响应、总耗时、工具调用和本机独立验证结果。
- timeout、HTTP 状态和清洗后的错误类别。
- sandbox、approval policy 和是否允许网络。

新结果应覆盖或另存为带日期的报告，并明确“当前事实来源仍是网关配置”。
