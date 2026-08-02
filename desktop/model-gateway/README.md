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
