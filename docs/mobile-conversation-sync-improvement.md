# 桌面→手机 对话同步改进方案

> 状态：设计评审稿（未实施）。目标读者：桌面/移动/协议负责人。
> 关联事实来源：`packages/protocol/src/index.ts`、`desktop/src/main/control-plane/app.ts`、`desktop/src/main/runtime.ts`、`desktop/src/main/control-plane/store.ts`、`mobile/src/state/control-reducer.ts`、`mobile/src/hooks/use-control-plane.ts`、`mobile/src/components/chat-screen-model.ts`。
> 本文是"方案"，不是接口定义；一旦落地，接口以协议源码为准，并回填本文件。

---

## 0. 结论先行（TL;DR）

手机端"数据混乱 / 顺序不一致 / 重复显示 / 每次全量拉取"不是四个独立 bug，而是**同一个设计缺陷的三个表象**：

> **`timeline` 用"墙钟时间戳 `createdAt`"作为排序与去重依据，但 `createdAt` 在不同数据路径下含义不一致（live=实时墙钟、历史 activity=`turn.startedAt`、历史正文=合成时间戳）。排序、去重、增量都建立在一个"不可比、不唯一"的键上。**

因此推荐**一次治本的契约升级**（Track B），而不是四处打补丁：

1. **引入权威顺序键 `orderKey`**（每线程单调、桌面在创建时分配并持久化）——排序只认它，`createdAt` 退化为纯展示。直接消灭"顺序不一致"和"live/历史两套时间戳混排"。
2. **统一身份 `logicalId`**（创建即分配，去重只认 `(threadId, logicalId)`）——消灭"重复显示"。
3. **增量游标同步**（本地持久化每线程游标 + 增量 delta 端点 + gap 时按 `after` 续拉而非全量重拉）——消灭"每次全部拉取"。
4. **正文/执行过程分离**（移动端默认只渲染 `kind ∈ {user, assistant}`，移除"执行过程"页）——满足"只显正文"。

若希望快速止血，先做 **Track A（最小改动）**；Track B 是治本目标，两者可分阶段推进，协议改动需桌面/手机/中转同版本协同（见 `docs/architecture.md`「协议边界」）。

---

## 1. 现状数据流（as-is）

```text
DesktopRuntime（权威节点）
  · Codex App Server 事件 → 构造 TimelineItem → TimelinePublishCoalescer(200ms 合流) → ControlStore.publish()
  · publish() 分配全局单调 sequence，apply() 写入内存 Map，emit("event")
  · 历史来源：rollout 文件 → toThreadDetail() 重建 messages(正文) + timeline(执行过程)
Control Plane (127.0.0.1)
  · GET  /v1/snapshot                  → 全量（内存 timeline Map，重启后 ≤250 条，跨所有线程）
  · WS   /v1/events?after=N            → 回放 sequence>N 的事件后实时流；缓冲 maxEvents=2000
  · GET  /v1/commands/threads/:id      → openThread：整线程历史（timeline 最多 50,000 条）
        │
Mobile Client
  · 冷启动 / 重连 / 前后台切换 / 检测到 gap → GET /v1/snapshot（全量）
  · 选中线程 → openThread（整线程）；若"稀疏"则立即重试≤4 次 + 软重试≤10 次（每次都全量）
  · 应用事件：applyAgentEvent / mergeControlSnapshot / dedupeTimelineItems（按 createdAt 排序）
  · 渲染：ChatScreen 双页 result(正文) / activity(执行过程)
```

关键事实（带证据）：

- **正文 vs 执行过程，在历史路径里是两条数组。** `toThreadDetail()`（`runtime.ts:2359`）把 `userMessage`/`agentMessage` 放进 `messages`，把 `commandExecution`/`fileChange`/`reasoning(notice)` 等放进 `timeline`（`runtime.ts:2406`）。
- **`createdAt` 三套语义：**
  - live：每个 item 发布时取 `new Date().toISOString()`（`runtime.ts:1498/1511/1524/1603`…）——实时墙钟，彼此不同。
  - 历史 activity：整 turn 共享 `turn.startedAt`（`runtime.ts:2374` → `2413`）。
  - 历史正文：合成升序 `baseTimestamp + index`，集中在 `thread.updatedAt` 附近（`runtime.ts:2604-2630`）。
- **排序与去重都以 `createdAt` 为锚。** `dedupeTimelineItems` 最终 `sort(createdAt → id)`（`protocol/index.ts:197`）；移动端 `compareChatEntries` 同样先 `createdAt` 后 kind（`chat-screen-model.ts:356`）。
- **全量拉取来源：** 冷启动全量 snapshot（`use-control-plane.ts:271`）+ 建连后立即再拉一次（`:327`）+ 任何 sequence gap 关连接→全量重拉（`:349`）+ 前后台切换全量重拉（`:404`）+ openThread 整线程（`App.tsx:519`）+ 稀疏重试最多 14 次全量（`App.tsx:516-599`）。**移动端无本地持久化**，状态全部在 React `useState` 内存里，冷启动即全量。
- **重启后 timeline 不进回放缓冲。** `isPersistedEvent` 明确排除了 `timeline.upserted`（`store.ts:248`），所以桌面重启后 `listEvents(after)` 没有历史 timeline，手机端只能靠全量 openThread 补齐历史。

---

## 2. 根因分析（问题 → 代码证据）

### 2.1 顺序不一致（"和桌面端生成顺序不一致"）

桌面"生成顺序"是逻辑事件序：`user → reasoning(分析) → command(执行命令) → file_change(修改文件) → agentMessage(正文)`。

手机端按 `createdAt` 排序，而历史路径下：
- 正文拿到 `thread.updatedAt` 附近的合成时间戳（全线程最后）；
- activity 拿到各自的 `turn.startedAt`（分散在 T1…TN）；

两套时间尺度混排 → **正文被整体挤到 activity 之后或乱序**。多轮对话尤其明显：桌面是 `u1 → a1 → u2 → a2`，手机重同步后变成"先所有 activity，再所有正文"或按 id 字母序打散。

> 直接证据：`runtime.ts:2374`（activity 全用 `turn.startedAt`）与 `runtime.ts:2604-2630`（正文用合成 `baseTimestamp+index`）并存，最终由 `protocol/index.ts:197` 的 `createdAt` 排序合并。

次生因素：同一 turn 内多 item 的 `createdAt` 相等时，排序回退到 `id.localeCompare`（`protocol/index.ts:198`），等于**按 id 字母序**决定顺序，进一步偏离真实生成序。

**触发时机正是"全量重同步"**：每次 gap/前后台/重连都会重跑历史重建 → 顺序重新打乱一次。所以"顺序不一致"和"全量拉取"互相放大。

### 2.2 重复显示（"重复显示"）

现有去重是**多套机制并存、键不一致**：

1. **provisional user ↔ canonical user**：`isProvisionalUserTimelineItem`（`protocol/index.ts:128`）识别 `user-*` 临时行，`dedupeUserTimelineItems` 用 `sameUserPayload`（归一化内容 + 附件签名）**内容匹配**去重（`protocol/index.ts:226`）。内容哪怕差一个字符就匹配失败 → 双行。
2. **乐观 pending ↔ 服务端 user 行**：`claimPendingTimelineMatches` 用 `clientMessageId` 精确匹配，失败则退化为"内容相同 + 时间窗 ±5 分钟"（`chat-screen-model.ts:310-336`）。超时/内容漂移 → 本地 optimistic 与服务器行**各显一次**。
3. **snapshot 合并保留策略**：`mergeControlSnapshot` 以 `timelineIdentity = threadId + (logicalId || id)` 为键，把"当前有、来没有"的行**保留**（`control-reducer.ts:85`）。若同一逻辑消息在 live 与 history 下 `logicalId`/`id` 不一致，两条都被保留 → 重复。

根本症结：**`logicalId` 不是"创建即分配的稳定身份"**。它是在 `publish()` 时"有才补"（`store.ts:259` `normalizeTimelineIdentity`），assistant 行常无 `logicalId` 也无 `clientMessageId`，于是 identity 退化成易变的 `id`；而 live 的 id 与 history 重建的 id 生成规则不同（`turnScopedItemId`，`item-identity.ts`），导致同一条消息两条 identity。

### 2.3 每次全量拉取（"存在每次全部拉取数据的问题"）

- snapshot 是**全量**（`/v1/snapshot`），且跨所有线程；`maxTimelineItems=250` 只是持久化上限，长会话内存 Map 可更大（`store.ts:16-19`）。
- 移动端**无本地持久化**，每次冷启动/重连/前后台/重连成功都全量重拉（`use-control-plane.ts:271,327,404`）。
- **gap 恢复走全量而非续拉**：`incomingSequenceAction` 判定 `gap` 后 `socket.close()` → 重新 `synchronize()` → 全量 `loadSnapshot()`（`use-control-plane.ts:349`）。而 WS 本支持 `after=N` 回放（`app.ts:775-783`）——却没被用于恢复。
- **openThread 是整线程**（`max 50,000`，`protocol/index.ts:527`），且稀疏检测会把它重放最多 14 次（`App.tsx:516-599`）。
- 弱网下 gap 高频 → 全量高频。

### 2.4 正文/执行过程未分离（"只显正文"）

移动端 `ChatScreen` 是**双页**：`result`（正文）与 `activity`（执行过程，带徽标）（`ChatScreen.tsx:101,138,207`）。`includeActivity = activePage === "activity"`（`ChatScreen.tsx:138`）。用户诉求是移动端**只保留正文**、去掉"显示很多调用功能"的模块——即默认/恒定 `includeActivity=false`，并移除 activity 页。

---

## 3. 改进方案

### 3.1 设计原则

- **桌面仍是唯一权威**：顺序、身份、增量都由桌面在"生成/重建"时确定，移动端只做"按权威键渲染 + 按游标取增量"，不再自己猜顺序、猜去重。
- **一个键解决排序，一个键解决去重**：`orderKey` 管顺序，`logicalId` 管身份。`createdAt` 只用于展示"何时"。
- **增量优先，全量兜底**：正常走 delta，只有游标失效（`< earliestReplaySequence` / stream 变更）才全量。
- **移动端最小化数据面**：正文页只需要 `user/assistant`；执行过程（若要保留入口）走懒加载。

### 3.2 三大支柱

#### 支柱一：权威顺序键 `orderKey`（治"顺序不一致"）

**定义**：每个线程一个单调递增整数，桌面在"首次创建该 timeline item"时分配，随 item 持久化。

**为什么它有效**：
- 生成时分配 → 天然等于生成顺序（`user` 先于 `reasoning` 先于 `command` 先于 `agentMessage`）。
- 历史重建 `toThreadDetail()` 按 `turn.items` 数组顺序（rollout 的权威顺序）依次分配 → **历史顺序 == 生成顺序**。
- live 与 history 用**同一把尺子**，彻底消除"两套时间戳混排"。

**改动点**：
- `protocol/index.ts`：`timelineItemSchema` 增加 `orderKey: z.number().int().nonnegative().optional()`（optional 保证旧客户端兼容，见 §5）。
- `store.ts`：ControlStore 增加每线程 `orderCounter`（持久化进 `ControlStoreState`），`publish(timeline.upserted)` 时若 item 无 `orderKey` 则分配 `++counter[threadId]` 并写回；`apply()` 按 identity upsert 时**保留更小的 orderKey**（首次为准）。
- `runtime.ts`：
  - live 各 `publishTimeline`（`:1491,1504,1517,1529,1543,1566,1596,1610`）不传 `orderKey`，交给 store 分配（保持"首次创建即定序"）。
  - `toThreadDetail()`（`:2375-2415`）在 `for (const item of turn.items)` 循环里为**每个** item（含 messages 与 timeline）按出现顺序分配 `orderKey`，并用它替代"`turn.startedAt` 当 createdAt 排序"的隐式假设。
  - `remoteMessageTimeline()`（`:2609`）不再用 `baseTimestamp+index` 决定顺序，改用传入的 `orderKey`；`createdAt` 仍给一个用于展示的值。
- **排序改键**：`dedupeTimelineItems` / `compareChatEntries` / store `snapshot()` 的 timeline 排序，全部改为 **先 `threadId` 分桶、桶内按 `orderKey` 升序**；`orderKey` 缺失时回退旧 `createdAt` 逻辑（兼容）。

**验收**：多轮对话在"live 实时 / 断线重连 / 桌面重启后 openThread"三种场景下，正文与执行过程的相对顺序**逐字节一致**，且等于桌面 UI 顺序。

#### 支柱二：统一身份 `logicalId`（治"重复显示"）

**定义**：`logicalId` 是"同一条逻辑消息"的**创建即分配、全局稳定**身份，去重只认 `(threadId, logicalId)`。

**分配规则（桌面创建时定死）**：
- 手机发起的 user 消息：`logicalId = client-message:<clientMessageId>`（沿用 `store.ts:261` / `runtime.ts:2620`，但**强制**写入 live 首帧，不再"有才补"）。
- 桌面发起的 user 消息：`logicalId = <turnScopedItemId>`（稳定 id）。
- assistant / command / file_change / notice：`logicalId = <turnScopedItemId>`（`turnId::itemId`，`item-identity.ts`），创建即写。

**改动点**：
- `store.ts`：`normalizeTimelineIdentity`（`:259`）从"补"改成"校验+补全"，保证每条 timeline item 出门都带 `logicalId`。
- `runtime.ts` live 发布：所有 `publishTimeline` 显式带 `logicalId`（= `turnScopedItemId`），让 provisional→canonical 的合并**靠 key 精确命中**，而不是靠 `sameUserPayload` 内容猜测。
- `protocol/index.ts`：
  - `dedupeTimelineItems` 的 identity（`:181`）改为**优先 `logicalId`**，`id` 仅作兜底。
  - 保留 `sameUserPayload` / `isStreamingContentDuplicate` 作为**兜底**（处理极个别旧数据），但不再是主路径。
- `chat-screen-model.ts`：`claimPendingTimelineMatches`（`:296`）的 optimistic↔server 匹配改为**优先 `clientMessageId` 精确命中**；±5min 内容匹配仅兜底，并**收窄**到同 `threadId` 且 `logicalId` 对齐。

**验收**：对同一条 user/assistant 消息，"live 实时 + openThread 历史 + snapshot 重拉 + 桌面重启"叠加后**恰好一行**；单元用例覆盖"内容漂移 / 同毫秒 / provisional+canonical 并存"三种易漏场景。

#### 支柱三：增量游标同步（治"全量拉取"）

**目标**：稳态只拉增量；全量仅作为游标失效的兜底。

**改动点**：

1. **移动端本地持久化**（新增，`mobile/src/storage/`）：
   - 每线程 `cursor = { orderKey, sequence }`、已渲染 timeline（AsyncStorage/SQLite，按线程分片、设上限）。
   - 冷启动/前后台恢复 → **先读本地**渲染，再拉增量补齐，不再从零全量。

2. **增量 delta 端点**（新增，桌面控制面 `app.ts`）：
   - `GET /v1/commands/threads/:id/timeline?afterOrderKey=N&limit=K` → 仅返回该线程 `orderKey > N` 的 item（分页）。
   - openThread 增加可选 `sinceOrderKey`：首次进线程才全量，其余走 delta。
   - 让 delta 成为默认，openThread(全量) 降级为"首次/游标失效"。

3. **gap 恢复改为续拉**（`use-control-plane.ts:349`）：
   - 判定 `gap` 后，**优先重连 WS 并带 `after=lastSequence`**（`app.ts:775` 已支持回放），仅当 `lastSequence < earliestReplaySequence`（`control.sync` 帧，`protocol/index.ts:644`）才回退全量 snapshot。
   - 建连后那次"额外全量 resync"（`:327`）改为**仅在确有未决缺口时**触发（对比 `lastSequence` 与首帧），否则跳过。

4. **收敛 catch-up**（`App.tsx:516-599`）：
   - "稀疏"判据（`isSparseThreadHistory`）改为**基于 orderKey 完整性**（该线程最大 orderKey 与本地一致即不稀疏），而非"正文数 < user 数"的启发式。
   - 把"立即 4 次 + 软 10 次全量 openThread"降为"少量 delta 补齐 + 指数退避"，弱网下不再风暴。

5. **桌面重启后的历史**：`isPersistedEvent` 排除 timeline（`store.ts:248`）保持不变（rollout 仍是真相），但 delta 端点直接基于"重建 + orderKey"提供增量，移动端不再需要整线程 openThread 也能补齐。

**验收**：在"连续弱网抖动 / 频繁前后台 / 桌面热重启"压测下，移动端**平均每次交互的拉取字节数**下降一个数量级；抓包确认稳态无 `/v1/snapshot` 与全量 openThread。

#### 支柱四：移动端只显正文（治"只显正文"）

**改动点**：
- `ChatScreen.tsx`：**移除 `activity` 页与切换**（`:101,128,138,207,259`），`buildChatEntries(props, includeActivity=false)` 恒定。
- `chat-screen-model.ts`：正文页数据源恒为 `kind ∈ {user, assistant}`（`:383-390` 已具备）。
- 可选保留：单条 turn 上一个可折叠"查看执行过程"（懒加载该 turn 的 activity，按 `orderKey` 定位），但**默认隐藏**、不占主列表。
- 桌面端**不变**（继续展示完整 Activity 时间线）。

**验收**：移动端默认只看到 user/assistant 正文，无 command/file_change/reasoning/notice 混入；正文顺序正确、无重复。

---

## 4. 分阶段落地

### Track A — 最小改动，快速止血（不动协议大改，先缓解）

| # | 改动 | 文件 | 解决 |
| --- | --- | --- | --- |
| A1 | gap 恢复改"续拉"：重连 WS 带 `after=lastSequence`，仅 `lastSequence < earliestReplaySequence` 才全量 | `use-control-plane.ts:349` | 全量拉取 |
| A2 | 建连后的额外 resync（`:327`）改为"有缺口才拉" | `use-control-plane.ts:327` | 全量拉取 |
| A3 | catch-up 收敛：稀疏判据 + 重试次数下调、指数退避 | `App.tsx:516-599`、`chat-screen-model.ts:106` | 全量拉取 |
| A4 | 移动端默认只显正文（恒 `includeActivity=false`，隐藏 activity 页） | `ChatScreen.tsx:138,207` | 只显正文 |
| A5 | 历史排序兜底：`toThreadDetail` 给 activity 用 `turn.startedAt + 序号`，正文用其后的 `+序号`，使同线程内正文恒在活动项之后且内部有序 | `runtime.ts:2374,2604` | 顺序不一致(缓解) |

> Track A 能显著缓解，但**顺序与去重仍是启发式**，强断网/多端并发下仍可能复现 → 需要 Track B 治本。

### Track B — 契约升级，治本（推荐目标态）

按 §3.2 四大支柱实施：`orderKey` → `logicalId` → 增量游标 → 正文分离。协议字段为**增量**（新增 optional），桌面/手机/中转按 `docs/architecture.md` 要求同版本协同发布。

**里程碑**：
1. 协议加 `orderKey`/`logicalId`（optional），桌面 store 分配并持久化，三端类型对齐。
2. 桌面 `toThreadDetail`/`remoteMessageTimeline` 用 `orderKey` 重建；三端排序改键。
3. 移动端本地持久化 + delta 端点 + gap 续拉。
4. 移动端正文-only 渲染；旧 activity 页下线（或转懒加载）。
5. 跨端契约测试 + 弱网压测，通过后全量发布，移除 Track A 的临时兜底。

---

## 5. 迁移与兼容

- **协议增量**：`orderKey`、强制 `logicalId` 均为**新增字段**。新桌面 + 旧手机：手机端忽略 `orderKey` 走旧 `createdAt` 排序（行为不回退）；旧桌面 + 新手机：`orderKey` 缺失 → 回退旧逻辑。**不出现"猜旧格式"**（符合 `architecture.md`「客户端不猜测旧字段」）。
- **存量历史回填**：桌面重启/首次加载时，对已持久化 timeline 按"当前稳定顺序"批量回填 `orderKey`（一次性，幂等）。
- **发布协同**：涉及协议/事件/状态码变更，按 `docs/README.md`「更新要求」同步更新本文件、`mobile-connection.md` 与 `architecture.md`。

---

## 6. 验证

- **协议单测**（`packages/protocol`）：`dedupeTimelineItems`/`preferTimelineItem` 覆盖"live 墙钟 + 历史合成时间戳混排""同毫秒""provisional+canonical 并存""内容漂移"四组用例，断言**顺序==orderKey、数量无重复**。
- **控制面单测**（`desktop`）：`store.publish` 分配 orderKey 幂等、`toThreadDetail` 重建顺序==rollout 顺序、`/timeline?afterOrderKey` 分页正确。
- **集成/弱网**：模拟"gap / 前后台 / 桌面热重启 / 多端并发"，断言：① 顺序与桌面一致；② 无重复行；③ 稳态无全量 snapshot/openThread。
- **跨端契约**：新增命令/字段同时实现"认证、运行时校验、幂等、跨端测试"（`architecture.md`「协议边界」）。

---

## 7. 风险与取舍

- **orderKey 持久化体积**：每线程一个计数器 + 每 item 一个 int，开销可忽略；但需保证"首次创建即定序"，避免后续 upsert 改序（用"保留更小 orderKey"策略）。
- **增量端点的幂等与并发**：delta 必须幂等（同 `afterOrderKey` 多次请求结果一致），并处理"生成中 item 仍在增长"——以 `orderKey` 定位 + 内容 upsert，天然幂等。
- **本地持久化上限**：移动端按线程分片 + LRU 上限，避免存储膨胀；超阈值线程下次进线程走一次全量重建。
- **桌面仍是瓶颈**：delta 依赖桌面在线（relay-only，`mobile-connection.md`）。桌面离线仍 `503`，移动端用本地缓存兜底展示，不改变现有离线语义。
