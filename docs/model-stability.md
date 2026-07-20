# 模型稳定性验证报告

验证时间：2026-07-17 00:50 至 01:20（Asia/Shanghai）

## 结论

桌面端当前列出的 26 个模型并非全部可用。本轮有 18 个模型通过代表性开发任务，8 个模型在初测和独立复测中都无法建立有效响应。

这里的“通过”表示模型完成了以下四项验证：

1. 连续两轮精确短响应。
2. 通过 shell 工具读取算力助手的 `package.json`。
3. 在算力助手的独立副本中创建一个 JavaScript 模块和一项 `node:test` 测试。
4. 模型运行测试后，由本机脚本再次独立运行并确认测试通过。

代码编辑阶段使用与桌面端“完全访问”一致的 `danger-full-access`。`workspace-write` 在 Windows 下会拒绝补丁写入，不适合作为这次模型能力判断依据。

## 本轮通过

| 模型 | 两轮响应 | 项目读取 | 代码编辑与独立测试 |
| --- | ---: | ---: | ---: |
| `faker/kimi-for-coding` | 2.2s / 2.1s | 13.5s | 9.6s |
| `faker/MiniMax-M2` | 2.2s / 1.9s | 4.4s | 32.8s |
| `faker/MiniMax-M2.1` | 1.8s / 1.6s | 4.2s | 25.4s |
| `faker/MiniMax-M2.1-highspeed` | 2.1s / 1.1s | 4.0s | 18.8s |
| `faker/MiniMax-M2.5` | 1.4s / 1.6s | 4.7s | 24.4s |
| `faker/MiniMax-M2.5-highspeed` | 1.3s / 1.4s | 3.9s | 24.0s |
| `faker/MiniMax-M2.7` | 2.7s / 2.3s | 6.1s | 20.5s |
| `faker/MiniMax-M2.7-highspeed` | 1.8s / 1.2s | 4.1s | 25.8s |
| `faker/MiniMax-M3` | 1.9s / 2.9s | 4.7s | 15.1s |
| `vllm/gemma-4-31b-it-uncensored-bf16` | 1.3s / 0.8s | 2.5s | 39.1s |
| `sub2api/gpt-5.3-codex-spark` | 2.3s / 2.8s | 4.3s | 17.8s |
| `sub2api/gpt-5.4` | 3.8s / 3.1s | 6.2s | 30.7s |
| `sub2api/gpt-5.4-2026-03-05` | 3.3s / 2.7s | 7.4s | 22.1s |
| `sub2api/gpt-5.4-mini` | 2.4s / 2.1s | 11.7s | 32.7s |
| `sub2api/gpt-5.5` | 2.6s / 3.6s | 7.3s | 16.9s |
| `sub2api/gpt-5.6-luna` | 1.8s / 2.6s | 8.8s | 22.6s |
| `sub2api/gpt-5.6-sol` | 3.0s / 6.1s | 9.9s | 34.0s |
| `sub2api/gpt-5.6-terra` | 12.6s / 4.8s | 6.9s | 22.9s |

## 当前不可用

| 模型 | 初测 | 独立复测 | 归因 |
| --- | --- | --- | --- |
| `faker/TrevorJS/gemma-4-26B-A4B-it-uncensored-GGUF` | 502 | 502 | Faker 上游请求失败 |
| `faker/fake-gpt-4o-mini` | 404 | 404 | Faker 报告模型不存在 |
| `vllm/gemma-4-31b-it-uncensored` | 502 | 502 | 非 BF16 路线上游请求失败 |
| `sub2api/gpt-5.2` | 503 | 503 | Sub2API 服务暂不可用 |
| `sub2api/gpt-5.2-2025-12-11` | 503 | 503 | Sub2API 服务暂不可用 |
| `sub2api/gpt-5.2-chat-latest` | 503 | 503 | Sub2API 服务暂不可用 |
| `sub2api/gpt-5.2-pro` | 503 | 502 | Sub2API 上游不可用 |
| `sub2api/gpt-5.2-pro-2025-12-11` | 503 | 503 | Sub2API 服务暂不可用 |

这些失败都由上游返回，模型选择和桌面端路由已经正确到达相应 Provider，不是桌面端模型切换错误。

上述 8 个模型已经记录在 `transfer/gateway.config.json` 的 `disabled_models` 中。网关会同时过滤静态配置和动态发现结果，因此桌面端、移动端和 `/v1/models` 均不再显示这些模型，直接请求也会被判定为不支持的模型。

## 使用建议

- 日常开发可优先使用 `sub2api/gpt-5.6-terra`、`sub2api/gpt-5.6-sol`、`sub2api/gpt-5.5` 或 `faker/kimi-for-coding`。
- 本地模型只能选择 `vllm/gemma-4-31b-it-uncensored-bf16`；非 BF16 版本当前不可用。
- BF16 31B 通过了本轮约 39 秒的代码任务，但此前长编码任务出现过长时间无输出，因此暂时只建议用于短任务，不能认定为长任务稳定。
- Faker 的 Kimi/MiniMax 和 Sub2API 5.3 至 5.6 在本轮均可完成真实文件修改；两轮测试不能替代数小时压力测试或长期可用性监控。

## 复测命令

基础矩阵：

```powershell
npm run smoke:models --workspace @rhzycode/desktop
```

包含隔离代码编辑：

```powershell
npm run smoke:models:coding --workspace @rhzycode/desktop
```

原始结果位于：

- `validation/model-stability/full-matrix.json`
- `validation/model-stability/coding-matrix.json`
- `validation/model-stability/workspaces/`
