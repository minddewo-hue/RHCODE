# Model Gateway

该目录实现 RHZYCODE 的内嵌模型网关。运行配置位于桌面应用根目录：

- `desktop/gateway.config.json`：Provider、模型映射、禁用模型和 `api_key_env`。
- `desktop/codex-model-catalog.json`：提供给 Codex 的模型目录。
- `desktop/model-context-windows.json`：模型上下文窗口元数据。
- `desktop/.env`：仅源码开发使用的本地凭据，不提交仓库。

桌面应用嵌入 `src/embedded.js`。网关负责 Provider 协议适配、模型目录、健康检查和错误清洗，不拥有项目文件、线程、审批或移动认证。

## 验证

```powershell
npm run gateway:test
npm run gateway:catalog
npm run smoke:models --workspace @rhzycode/desktop
npm run smoke:models:coding --workspace @rhzycode/desktop
```

修改 Provider 或模型配置后重新生成模型目录，并确认桌面、移动和 `/v1/models` 的可见模型一致。

## 凭据

Provider Key 必须通过 `api_key_env` 指定的环境变量或桌面安全凭据存储提供。不要在 `gateway.config.json` 写入 `api_key`，不要在日志、健康状态或测试产物中输出密钥值。

模型可用性会随上游变化。当前状态以 `gateway.config.json` 和重新执行的矩阵为准；[模型稳定性报告](../../docs/model-stability.md) 只是带日期的验证快照。

## 输出截断与恢复

Chat Completions 适配器保留上游结束原因：`stop` / `tool_calls` 为正常结束，`length` 转为 `response.incomplete`（`max_output_tokens`），`content_filter` 保持未完成状态。没有有效 `finish_reason` 的 EOF 或 `[DONE]` 报告失败；已有有效结束原因时允许省略 `[DONE]`。所有工具参数在发送可执行的 `output_item.done` 前统一校验，截断或无效的参数不会交给执行器。

上游 `reasoning_content`（以及字符串 `reasoning`）通过独立的 Responses reasoning item 和 `response.reasoning_text.delta` 实时转发，不混入最终答复。忽略这类思考数据会使 Codex 在上游仍持续生成时误判 SSE 空闲并中断/重试。结束日志分别记录思考文字与答复文字的字符数，不保存正文。

桌面在同一会话中自动续接明确因 `length` 截断、非空且不含工具调用的文字输出，每次用户请求最多两次。对 `qwen3.8-27b-uncensored-fp8`，已有成功工具操作的任务在正常 `stop` 后另行检查是否仍有明确未完成的工作：使用同一个模型、禁用执行工具且约束为 JSON 输出的独立检查请求，区分已完成、可以继续、等待输入和实际阻塞。只有“可以继续”才考虑续跑，并检查新的成功工具操作，最多八次；相同工具和结果不会重复计作进展。检查失败、真实阻塞、连续无新进展或达到限制时报告未完成，不宣称成功。

两种续跑都受从原始请求开始计时的 30 分钟预算约束，并沿用原模型、沙箱、审批和推理设置。仅回复计划而未新增工具结果时允许一次纠正重试，连续两次无新进展则停止。用户停止、开始新请求、切换模型、关闭会话或重启 Agent Host 会取消待续跑和完成检查。等待审批/输入、内容过滤和工具参数截断不触发续跑；普通断流交给 Codex 自身的流重试处理。完成检查是模型判断，重要任务仍需依据实际文件和测试结果验收。

该 Qwen 部署默认使用 `none`，通过 `chat_template_kwargs.enable_thinking=false` 直接执行任务。模型目录提供 `high` 选项用于显式启用思考；启用时思考流会正常转发。此部署专用策略按完整模型名称匹配，不改变其他模型的采样设置。

该部署启用原生 `apply_patch` 编辑工具，Chat 适配层将 JSON `patch` 参数映射回 Codex custom tool input，避免源码经多层 PowerShell 引号与反斜杠转义后写坏。执行仍受当前会话的沙箱和审批约束。

结束元数据保存在 Electron `userData/codex-home/logs/gateway-outcomes.jsonl`；覆盖 Codex Home 时使用相应目录。日志记录请求/轮次 ID、结束原因、结束标记、输出字符数、请求的输出预算及上游提供的 token 用量，不记录提示词、回复正文、工具参数或密钥。单文件上限 2 MiB，保留一份轮转备份。`max_output_tokens: null` 表示客户端未指定额度，实际额度须到模型服务端核对；`usage_received: false` 表示上游没有提供用量，不能当作零用量。

默认每次上游请求总超时为 600 秒、流空闲超时为 300 秒。它们不限制整个多轮任务的执行时间；反向代理和模型服务可能有独立限制。上下文容量和输出额度必须按实际部署核实，不能仅按模型名称推断。
