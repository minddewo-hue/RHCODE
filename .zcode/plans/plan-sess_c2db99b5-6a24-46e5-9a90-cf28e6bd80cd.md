## 目标
修复 Windows 长时间运行后手机端显示“电脑离线”的两条已复现链路：

1. 桌面中转客户端已注册、桌面本地控制服务也健康，但经中转调用仍返回 `502 desktop_relay_failed`；根因范围锁定在 Electron `net.fetch` 从主进程访问本机回环控制服务失败。
2. 桌面主进程句柄数会随五分钟一次的诊断采样持续上涨，最终超过 17,000，进一步放大 Chromium 网络栈失效风险。

现有未提交改动不会被覆盖；只改与此故障直接相关的桌面源码和测试。

## 实施步骤

1. **隔离中转回环请求的网络实现**
   - 调整 `desktop/src/main/runtime.ts` 与 `desktop/src/main/desktop-relay-client.ts`，让 `DesktopRelayClient` 的“中转 → 本地 `127.0.0.1` 控制服务”请求使用专用的 Node `globalThis.fetch` 实现。
   - 保持 `index.ts` 中的 `systemFetch` 继续服务于网关、更新等现有外部请求，不把整个 Windows 应用从 Electron `net.fetch` 全面切换，避免扩大行为变更。
   - 保留 relay client 的可注入 fetch seam，便于测试故障路径；不改变 WebSocket 注册、心跳、请求超时、35 MiB 负载上限或命令转发语义。

2. **记录安全且可操作的中转本地转发错误**
   - 在 `desktop/src/main/desktop-relay-client.ts` 的本地转发 catch 分支中增加专用诊断事件。
   - 事件只记录：HTTP 方法、无查询参数的控制路径、本地 origin（仅 `127.0.0.1:端口`）、错误名、受长度限制并脱敏后的错误代码/消息、是否为超时。
   - 明确移除/掩盖 `Bearer` 值、`rhzy_...` 访问 KEY、请求正文、授权头和查询参数；手机仍只收到当前通用的 502 信息，避免向远端暴露桌面内部细节。
   - 由 `DesktopRuntime` 转发该事件，`index.ts` 接入现有 `ProcessDiagnostics`，把脱敏信息写入本地 JSONL 诊断日志，并向桌面 UI 发送不含底层细节的恢复提示。

3. **停止 Windows 周期采样重复刷新 Electron 进程清单**
   - 修改 `desktop/src/main/process-diagnostics.ts`：周期性采样不再调用 `app.getAppMetrics()`；仅在启动、渲染器就绪、手动采样、退出或进程异常等事件边界刷新进程清单。
   - 周期采样继续使用已缓存的 PID 清单采集已有的 Windows 资源指标，以保留句柄压力可观测性，同时避开已与五分钟节奏高度相关的 Electron 进程监控句柄增长。
   - 保持 Windows PowerShell 资源查询的现有“单次在途”保护及最佳努力失败策略，不把未经证实的 PowerShell 查询直接移除。

4. **补齐回归测试**
   - 在 `desktop/test/desktop-relay-client.test.ts` 增加一个注入失败 fetch 的转发测试：断言中转仍得到 502、诊断事件包含可定位字段、并断言事件序列化后不包含测试 KEY 或 Authorization 值。
   - 在相关 runtime 测试（或现有 relay-client 注入测试）验证：即使运行时的通用 fetch 是外部网络实现，中转本地转发仍采用专用 Node fetch；网关 fetch 注入行为不受影响。
   - 在 `desktop/test/process-diagnostics.test.ts` 增加 Windows/no-proc 场景：启动时读取一次 Electron 进程指标，连续周期采样不再重复读取，但仍能写入 Windows 资源快照。
   - 更新已有断言以匹配新增的诊断事件和异步采样行为。

5. **验证与运行时复测**
   - 运行桌面 TypeScript 检查与桌面测试套件。
   - 构建桌面主进程以确认 Electron/Vite 编译通过。
   - 完整重启当前桌面开发应用（不是仅刷新渲染页），等待中转重新注册后，用不输出访问 KEY 的本地探针验证 `/control/v1/snapshot` 能通过中转返回成功；同时确认本地控制服务与 relay 心跳稳定。

## 明确不做的事项

- 不自动重试 POST/PUT/PATCH/DELETE 中转命令，避免在不确定请求是否已执行时产生重复操作；如将来要重试，只会为幂等 GET/HEAD 单独设计。
- 不轮换、打印、复制或写入手机访问 KEY。
- 不修改中转服务器协议、手机应用配置或现有不相关的工作区改动。