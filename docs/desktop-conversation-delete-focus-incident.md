# 桌面端删除对话后输入框失焦：修复复盘

本文记录 RHZYCODE 桌面端在连续执行“删除对话 -> 切换对话”后，输入框长时间不能输入的问题。后续遇到输入框高亮但没有光标、点击后仍不能输入、重启后暂时恢复等现象时，应先按本文检查，不要只依赖 DOM 或 IPC 自动化测试。

> 2026-08-11 后续调整：已移除输入框自动聚焦、窗口激活焦点恢复、删除/切换后的焦点恢复，以及模型下拉框自动聚焦和按会话自动改选模型。现在由用户的鼠标点击决定活动控件；输入框始终可编辑，历史加载只限制发送，不限制输入。

## 结论

根因不是 `thread/delete` 执行慢，也不是对话数据量本身，而是删除线程时调用了 renderer 中的 `window.confirm`。

在 Electron/Windows 下，这个调用会创建原生模态确认框。用户用鼠标确认后，模态框虽然消失，textarea 也可能重新获得 DOM `focus` 并显示高亮边框，但 Electron renderer 不一定重新获得 Windows 原生键盘焦点。此时会出现：

- 输入框有 `:focus-within` 样式，但没有输入光标。
- `document.activeElement` 可能仍是 textarea。
- `document.hasFocus()` 为 `false`，或者键盘事件完全到不了 renderer。
- 鼠标再次点击输入框也不一定恢复。
- 首次删除可能很快恢复，连续删除后更容易稳定复现。

最终修复是将线程永久删除确认从 `window.confirm` 改为 React 应用内模态框。确认过程不再创建新的 Windows 原生窗口，键盘焦点始终留在同一个 Electron renderer 中。

## 用户可见现象

典型复现步骤：

1. 使用 `desktop/run.bat` 启动真实桌面应用。
2. 在包含大量真实历史对话的侧边栏中，用鼠标打开线程菜单。
3. 点击 `Delete task permanently`，在确认框中确认删除。
4. 切换到另一个对话，再连续删除一个或多个对话。
5. 点击底部输入框并立即输入。

故障状态下输入框边框高亮，但没有 caret，键盘输入无效。应用重启后通常暂时恢复，之后再次连续删除还会出现。

## 排查过程中发现的次要问题

本次处理持续较久，是因为同时发现了多个真实问题，但它们与键盘焦点故障不是同一个根因。

### stale rollout path

曾出现以下诊断：

```text
state db returned stale rollout path for thread <thread-id>: <rollout-path>.jsonl
```

原因是本地 rollout 文件已删除，但 App Server 状态库仍可能在扫描或返回旧路径。删除顺序已调整为先调用 App Server `thread/delete`，再移除本地 JSONL，并在删除进行中隐藏线程。

这条错误需要修复，但它消失后输入框仍会失焦，因此不能把它当作输入故障的根因。

### 大历史文件重复扫描

真实数据中存在约 50 MB 的 rollout。打开或切换线程时，主进程曾顺序重复扫描同一 JSONL，用于线程详情、上传图片和托管文件恢复，单次可占用数百毫秒。

相关优化包括：

- 缓存 rollout 路径查找。
- 避免生成图片和线程详情重复扫描。
- 初次详情加载使用已索引的托管文件列表。
- 解析大 JSONL 时定期 `setImmediate`，避免长时间占住主进程事件循环。

这些改动改善删除和切换响应，但无法修复“DOM 有焦点、Windows 键盘焦点丢失”的状态。

### 删除完成后反复调用 focus

早期尝试在确认前、乐观删除后、IPC 完成后和 `finally` 中多次调用 textarea `.focus()`。这会让自动化测试看到 `toBeFocused()` 通过，却不能保证 Windows 将键盘输入发送给 renderer。

结论：DOM `.focus()`、蓝色边框和 `document.activeElement` 都不能单独证明输入可用。

## 根因确认方法

### 性能与焦点日志

诊断日志位置：

```text
%APPDATA%\@rhzycode\desktop\codex-home\logs\interaction-performance.jsonl
```

关键事件：

| 事件 | 含义 |
| --- | --- |
| `delete-confirmed` | 用户确认永久删除 |
| `delete-optimistic-removed` | renderer 已立即移除线程行 |
| `delete-ipc-completed` | main/App Server 删除完成 |
| `thread-switch-started` | 开始切换线程 |
| `composer-focus-requested` | renderer 请求 textarea 聚焦 |
| `composer-focus-event` | textarea 收到 DOM focus |
| `composer-keydown` | 键盘事件到达 textarea |
| `composer-input` | textarea 的值发生变化 |
| `composer-native-focus-restored` | main 窗口与 webContents 已尝试恢复焦点 |

故障时可以看到 `composer-focus-event`，但之后没有 `composer-keydown`/`composer-input`；另一种复现中 `composer-keydown.detail.documentFocused` 为 `false`。这证明删除 IPC 已结束、DOM 也可能聚焦，但原生键盘目标不在 renderer。

### 为什么原有测试没有发现

原有 Playwright 测试直接调用页面元素、监听 `dialog`、使用 `locator.fill()` 或 `page.keyboard.type()`。这些操作验证 React 状态和 DOM 可编辑性，但不能完整模拟：

```text
Windows 鼠标点击
  -> Electron 原生 confirm 窗口
  -> Windows 鼠标确认
  -> 原生窗口销毁
  -> Windows 重新选择键盘目标
  -> 物理键盘输入
```

测试数据较少时，大文件扫描延迟也不明显，容易将“删除很快、DOM focus 正常”误判为问题已解决。

## 最终修复

### 应用内删除确认

线程菜单仍调用 `permanentlyDeleteThread`，但该函数现在只关闭菜单并设置 `deleteConfirmation` 状态。React 使用现有 `AppModal` 渲染 `Delete conversation` 对话框，用户点击 `Permanently delete conversation` 后才调用 `confirmPermanentThreadDeletion`。

主要代码：

- `desktop/src/renderer/src/App.tsx`
  - `deleteConfirmation` 状态。
  - `permanentlyDeleteThread` 打开应用内确认框。
  - `confirmPermanentThreadDeletion` 执行乐观删除和后台 IPC。
- `desktop/src/renderer/src/components/AppModal.tsx`
  - 通用 renderer 模态框。
- `desktop/src/renderer/src/components/DeleteConfirmationDialog.tsx`
  - 对话与项目删除共用的应用内确认框。
- `desktop/src/renderer/src/hooks/useInteractionTrace.ts`
  - 删除、切换和输入焦点的统一诊断事件。
- `desktop/src/renderer/src/styles.css`
  - 删除确认框与危险按钮样式。
- `desktop/e2e/desktop.spec.ts`
  - 删除测试改为点击应用内确认按钮。

不要把线程删除改回 `window.confirm`。需要用户确认且确认后要立即继续键盘输入的 renderer 流程，应优先使用应用内模态框。

### 乐观删除

确认后 renderer 立即执行以下操作，不等待 App Server：

1. 标记线程正在删除。
2. 清理线程视图缓存和活动状态。
3. 从侧边栏线程列表移除。
4. 如果删除的是当前线程，切换到新任务状态。
5. 后台调用 `window.rhzycode.deleteThread`。
6. 失败时显示 Activity 错误并重新加载线程列表。

因此，侧边栏响应时间不再取决于真实历史文件大小或 App Server 清理时间。

### 不再自动管理输入焦点

后续真实数据测试仍发现连续删除后偶发不能输入，因此删除了 `useComposerFocus`、`window:focus-contents`、`window:focused` 和所有删除/切换后的 `focus()` 调用。删除确认按钮也不再使用 `autoFocus`。

模型下拉框只接受用户直接选择。打开历史会话不再根据 `thread.model` 自动改选当前模型，`/model` 无参数时也不再自动聚焦或打开模型下拉框。这样删除、会话加载和模型同步都不会改变当前活动控件。

## 验证结果

本次修复完成后执行：

```powershell
npm run typecheck --workspace @rhzycode/desktop
npm run build --workspace @rhzycode/desktop
Push-Location desktop
npx playwright test --config=playwright.config.ts --ignore-snapshots
Pop-Location
```

四个删除与切换回归场景全部通过。

随后重启 `desktop/run.bat`，在真实用户数据上使用 Windows 系统级鼠标点击线程菜单、删除项和应用内确认按钮。连续删除日志中，删除 IPC 完成约为 23-29 ms。最后使用系统鼠标点击输入框、系统键盘输入 `POSTDELETEONE`：

- Windows UI Automation 读取到完整输入值。
- `HasKeyboardFocus` 为 `true`。
- 每个 `composer-input` 的 `documentFocused` 都为 `true`。
- 验证后测试草稿已清空。

## 后续排查顺序

再次出现类似问题时，按以下顺序检查：

1. 确认运行进程来自 `desktop/run.bat`，修改源码后完整重启进程树。
2. 查看 `interaction-performance.jsonl`，确认最后一个 `delete-ipc-completed` 是否很快完成。
3. 点击输入框并输入，检查是否有 `composer-keydown` 和 `composer-input`。
4. 有 `composer-focus-event` 但无键盘/输入事件时，优先检查原生窗口、菜单、文件选择器和其他模态窗口的焦点归还。
5. `composer-keydown` 中 `documentFocused: false` 时，不要继续增加 textarea `.focus()`；检查 `BrowserWindow`/`webContents` 原生焦点。
6. 只有 `delete-ipc-completed` 本身很慢时，才继续分析 App Server、rollout 扫描和文件删除性能。
7. 自动化验证之后，必须补一次真实鼠标删除、真实鼠标切换和系统键盘输入测试。

## 回归测试要求

涉及线程删除、原生对话框或输入焦点的修改，至少覆盖：

- 取消删除后输入可用。
- 删除当前对话后立即输入可用。
- 删除非当前对话后当前草稿不丢失。
- 删除进行中切换对话并输入。
- 连续删除多个对话后切换并输入。
- 大历史数据下删除列表立即响应。
- Windows 真实鼠标与系统键盘验证，而不只检查 DOM `toBeFocused()`。

如其他流程继续使用 `window.confirm`，并且确认后需要立即回到输入框，应按同样风险处理或迁移为 `AppModal`。
