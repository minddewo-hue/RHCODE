# Codex 多模型中转整合交接文档

> 整理日期：2026-07-14  
> 目标：供新对话重新梳理和实施使用。本文只记录现状、风险与建议，没有修改现有业务代码。  
> 安全要求：不要把 `.env`、上游 API Key、网关 Key 或登录令牌贴到对话中。

## 1. 目标

希望 Codex 只配置一个中转地址，但可以使用多个来源的模型：

- 本地 vLLM、Unsloth 或其他 OpenAI 兼容模型；
- `https://faker-model.rhzy.ai/` 已配置的模型；
- `https://model.rhzy.ai/keys`（Sub2API）提供的模型；
- 后续新增的 OpenAI Responses、Chat Completions 或 Anthropic Messages 上游。

期望调用关系：

```text
Codex
  -> POST /v1/responses
  -> 统一网关/路由器
       |- 本地模型
       |- Faker Gateway 模型
       `- Sub2API 模型
```

Codex 侧只维护一个 `model_provider`，通过不同的 `model` ID 选择模型。

## 2. 当前本地项目

当前目录是：

```text
D:\work_space\RHZYCODE\desktop\model-gateway
```

主要文件：

```text
server.js                    Node.js 中转实现
README.md                    当前用法
codex-config.example.toml    Codex 配置示例
start-proxy.ps1              启动脚本
stop-proxy.ps1               停止脚本
..\.env                     桌面版本地密钥和配置，禁止提交或展示
```

项目当前不是 Git 仓库。`package.json` 版本为 `0.1.0`，要求 Node.js 20 或更高版本。

### 2.1 当前工作方式

当前 `server.js` 是单上游协议转换器，不是多上游路由器：

```text
Codex Responses API
  -> http://127.0.0.1:8787/v1/responses
  -> Responses 请求转换为 Chat Completions 请求
  -> ${UPSTREAM_BASE_URL}${UPSTREAM_CHAT_PATH}
```

默认上游为：

```text
https://faker-model.rhzy.ai/v1/chat/completions
```

当前关键限制：

- `UPSTREAM_BASE_URL` 只有一个；
- `UPSTREAM_CHAT_PATH` 只有一个；
- `UPSTREAM_API_KEY` 只有一个；
- `UPSTREAM_MODEL` 非空时会覆盖 Codex 请求中的 `model`；
- `GET /v1/models` 只返回一个模型；
- 所有请求最终都按 Chat Completions 协议发送到同一上游；
- 没有 provider 注册表、模型路由表、健康检查、熔断或故障转移。

已经实现的能力：

- Responses `input`、`instructions` 转换为 Chat `messages`；
- function tools 和 tool calls 双向转换；
- 非流式 Chat 响应转换为 Responses 响应；
- Chat SSE 转换为 Responses SSE；
- 可分别配置本地代理鉴权和上游鉴权；
- 请求体大小限制和上游超时。

## 3. 两个远端平台的实测结果

以下结果来自 2026-07-14 的只读检查，后续实施前应重新验证。

### 3.1 Faker Gateway

地址：`https://faker-model.rhzy.ai/`

已确认存在：

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
POST /v1/messages
```

管理前端已经具备多个 provider、模型同步、手动模型、模型测试和按 Key 限制模型等功能。

检查时可见 4 个 provider、12 个公开模型：

- MiniMax：8 个；
- Kimi：1 个；
- 本地 vLLM：1 个；
- 本地 Unsloth：1 个；
- Fake 测试模型：1 个。

Faker 的多 provider 上游类型目前主要是：

```text
OpenAI 格式     -> /v1/chat/completions
Anthropic 格式  -> /v1/messages
```

虽然 Faker 对 Codex 暴露了 `/v1/responses`，但管理界面没有明确的 `OpenAI Responses` 上游类型。

### 3.2 Sub2API

用户 Key 页面：`https://model.rhzy.ai/keys`

当前部署实测：

```text
GET /v1/models          -> 401，路由存在，需要 Bearer Key
GET /v1/responses       -> 401，路由存在，需要 Bearer Key
GET /responses          -> 401，路由存在，需要 Bearer Key
GET /v1/chat/completions -> 404
GET /v1/messages         -> 404
```

因此，不能假设当前部署可作为普通 Chat Completions provider 接入 Faker。应使用 Responses，或者先查清 Sub2API 中对应分组是否启用了 Chat/Messages 协议分发。

Sub2API 上游开源项目：

```text
https://github.com/Wei-Shaw/sub2api
```

其源码具备 Responses、Chat Completions、Anthropic Messages、模型映射、多账户调度和部分协议桥接能力，但线上部署的版本与功能开关必须以实测为准。

## 4. 紧急安全问题

检查发现 Faker Gateway 的管理读取接口可以匿名访问：

```text
/proxy/providers
/proxy/models
/proxy/api-keys
/proxy/config
```

其中管理响应会返回未脱敏的上游 API Key，`/proxy/api-keys` 还返回了未脱敏的网关 Key。检查时共有 13 个网关 Key。本文没有记录、展示或使用任何 Key，也没有调用写接口。

在继续集成前必须完成：

1. 立即限制 `/proxy/*` 的公网访问，可先使用 Nginx Basic Auth、IP allowlist 或 Cloudflare Access。
2. 轮换所有已经暴露的上游 API Key 和 Faker 网关 Key。
3. 管理接口不再返回原始密钥，只返回 `has_api_key`、前缀和末四位。
4. 网关 Key 只保存不可逆摘要；上游 Key 使用 AES-GCM 或 KMS 加密保存。
5. 管理鉴权与 `/v1/*` 推理鉴权分离，并增加管理员审计日志。
6. 确认所有写接口同样要求管理员权限和 CSRF/Origin 防护。

密钥轮换完成前，不应把更多 Sub2API、本地平台或商业模型凭据添加到 Faker。

## 5. 推荐架构

不要让 Codex 直接管理多个平台。Codex 可以声明多个 provider，但一次会话只选择一个 provider；真正的聚合、路由和故障转移应放在统一网关中。

需要先在下一段对话中确定唯一的控制面，避免长期维护两层重复网关。

### 方案 A：Faker 作为唯一统一网关

```text
Codex -> Faker /v1/responses -> Faker 内部 provider 路由
```

优点：Faker 已有多个 provider、模型管理和 API Key 权限界面。

需要补齐：

- 增加 `openai_responses` 上游类型；
- 将 Sub2API 配置为 Responses provider；
- Responses 上游优先透明转发，不先降级为 Chat；
- 修复管理端鉴权和密钥泄露；
- 完善健康检查、能力标记和故障转移。

### 方案 B：本地 `D:\work_space\test` 作为唯一统一网关

```text
Codex -> 127.0.0.1:8787/v1/responses -> 本地 provider 路由
```

优点：密钥留在本机，可同时接入 Faker、Sub2API 和局域网模型。

需要把当前单上游转换器重构为多 provider 路由器，包括配置加载、模型注册表、协议适配器和健康状态。

如果目标只是个人本机使用，方案 B 的安全边界更简单。如果目标是多人共享和公网服务，方案 A 更符合现有产品形态，但必须先完成安全整改。

## 6. 多 provider 的建议数据结构

建议把 `UPSTREAM_*` 单值环境变量替换为结构化配置，但密钥仍从环境变量读取：

```yaml
providers:
  faker:
    base_url: https://faker-model.rhzy.ai/v1
    protocol: responses
    api_key_env: FAKER_API_KEY

  sub2api:
    base_url: https://model.rhzy.ai/v1
    protocol: responses
    api_key_env: SUB2API_API_KEY

  local_vllm:
    base_url: http://127.0.0.1:8002/v1
    protocol: chat_completions

models:
  faker/kimi-for-coding:
    provider: faker
    upstream_model: kimi-for-coding

  sub2api/gpt-codex:
    provider: sub2api
    upstream_model: gpt-5.5

  local/gemma:
    provider: local_vllm
    upstream_model: gemma-4-26b-a4b-it-uncensored
```

公开模型 ID 应带命名空间，防止不同平台出现同名模型：

```text
faker/<model>
sub2api/<model>
local/<model>
```

每个模型还应记录：

- `protocol`；
- `context_window`；
- 是否支持 function tools；
- 是否支持并行工具调用；
- 是否支持图像输入；
- 是否支持 reasoning 参数；
- 是否支持流式输出；
- 超时和最大输出限制；
- 可用状态与最近一次探测结果。

并不是所有能聊天的本地模型都适合 Codex。至少要验证工具调用、结构化参数、长上下文和多轮工具结果回传。

## 7. 协议处理原则

统一入口使用 Responses API：

```text
POST /v1/responses
GET  /v1/models
GET  /health
```

按上游协议选择适配器：

```text
responses          -> 尽量原样透传请求、SSE 事件和错误
chat_completions   -> 使用当前 server.js 的 Responses/Chat 转换
anthropic_messages -> 增加 Responses/Anthropic 转换器
```

关键原则：

- 不要把原生 Responses 上游先转换成 Chat，否则会损失 reasoning、事件类型和部分工具语义；
- SSE 开始发送给 Codex 后，不再自动切换上游；
- 故障转移只能发生在响应流开始之前；
- 只允许同一个实际模型的多个副本互相故障转移；
- 不要把不同能力的模型伪装成同一个模型进行随机负载均衡；
- `previous_response_id` 或粘性会话必须继续路由到原 provider；
- 记录请求 ID、provider、公开模型、上游模型、延迟、状态和 token 使用量，但不能记录密钥。

## 8. Codex 配置

统一网关完成后，Codex 只需要一个 provider。以本地统一网关为例：

```toml
model_provider = "rhzy_gateway"
model = "faker/kimi-for-coding"

[model_providers.rhzy_gateway]
name = "RHZY Unified Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "RHZY_GATEWAY_API_KEY"
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 300000
```

不要为自建网关设置 `requires_openai_auth = true`；使用自定义 `env_key`。

PowerShell 临时设置：

```powershell
$env:RHZY_GATEWAY_API_KEY = "<rotated-gateway-key>"
codex -m "faker/kimi-for-coding"
codex -m "sub2api/gpt-codex"
codex -m "local/gemma"
```

Codex 支持通过 `-m` 传入模型 ID。如果希望私有模型完整显示在 `/model` 选择器中，需要额外生成 `model_catalog_json`；这属于第二阶段体验优化，不应阻塞网关路由实现。

官方参考：

- https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers
- https://learn.chatgpt.com/docs/models

## 9. 建议实施顺序

1. 修复 Faker `/proxy/*` 未鉴权和明文密钥返回问题。
2. 轮换全部已暴露密钥，并确认旧 Key 失效。
3. 明确采用方案 A 还是方案 B，确定唯一控制面。
4. 将 provider、model 和密钥配置从单值环境变量拆分为注册表。
5. 实现 Responses 透明上游适配器。
6. 保留并封装当前 Chat Completions 转换逻辑。
7. 按需要实现 Anthropic Messages 适配器。
8. 实现 `/v1/models` 聚合、模型别名与能力字段。
9. 增加健康检查、首包前重试、熔断和会话粘性。
10. 完成 Codex 非流式、流式、工具调用和错误场景测试。
11. 最后再生成 Codex `model_catalog_json` 和模型选择器体验。

## 10. 验收标准

至少覆盖以下场景：

- `GET /v1/models` 返回所有允许访问的公开模型 ID；
- Codex 使用 `-m` 可以选择不同 provider 的模型；
- 普通文本非流式请求成功；
- 普通文本 SSE 请求成功且事件顺序正确；
- 单个 function tool 调用成功；
- 多轮工具调用和 tool result 回传成功；
- 并行工具调用根据模型能力正确启用或拒绝；
- 上游 401、403、404、429、5xx 能转换成清晰的 OpenAI 风格错误；
- 上游连接超时可在首包前重试；
- SSE 中断后不会错误切换到另一个模型；
- 无权限的模型返回 403；
- 日志、健康接口和管理 API 不泄露任何 Key；
- Faker、Sub2API 和至少一个本地模型各完成一次 Codex 实际任务。

## 11. 新对话需要先确认的问题

1. 统一网关只供本机使用，还是要作为多人公网服务？
2. 最终控制面选择 Faker，还是 `D:\work_space\test` 本地代理？
3. Sub2API Key 绑定了哪些平台、分组和模型？
4. 是否必须支持 Anthropic、Gemini，还是第一阶段只支持 Responses 和 Chat？
5. 同一模型是否存在多个等价上游，需要优先级或故障转移？
6. 是否需要动态同步模型，还是先使用静态配置文件？
7. 是否需要 Codex `/model` 选择器完整展示私有模型？
8. Faker 安全整改是否已经完成，所有暴露 Key 是否已经轮换？

## 12. 给下一段对话的建议开场

可以在新对话中直接说明：

```text
请先阅读 D:\work_space\test\CODEX_MULTI_MODEL_GATEWAY_HANDOFF.md。
正确源码目录是 D:\work_space\test。先只读检查 server.js、README.md、
codex-config.example.toml 和当前配置结构，不要读取或输出 .env 密钥，
也不要立即修改代码。请先复核文档结论，再确定方案 A 或方案 B，
并把安全整改放在功能扩展之前。
```
