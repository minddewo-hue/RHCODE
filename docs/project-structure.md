# 项目结构与依赖边界

本文档定义 RHZYCODE 当前的代码所有权和跨平台扩展边界。新增平台能力时先选择正确层级，不在应用入口中直接增加平台判断。

## 仓库结构

```text
desktop/                         Electron 桌面应用
  src/main/platform/             桌面操作系统适配
  src/main/control-plane/        移动控制 API 与事件存储
  src/main/                      Agent Host 和本地基础设施
  src/preload/                   受限 IPC 桥
  src/renderer/                  桌面 UI
  model-gateway/                 模型供应商适配
mobile/                          Expo / React Native 移动应用
  src/platform/update/           Android/iOS 更新策略和状态机
  src/api/                       桌面控制 API 客户端
  src/hooks/                     跨组件应用状态
  src/components/                移动 UI
  modules/                       Expo 原生模块；当前仅 Android APK 安装器
packages/
  protocol/                      桌面与移动控制协议、Zod 运行时校验
  update-contract/               四个平台共享的更新清单与版本规则
appupdate/                       构建、暂存、发布和旧更新服务兼容层
docs/                            架构、平台开发和发布说明
```

## 依赖方向

```text
desktop ─┬─> packages/protocol
         └─> packages/update-contract

mobile  ─┬─> packages/protocol
         └─> packages/update-contract

appupdate ─> packages/update-contract
```

`packages` 不得依赖任一应用。`desktop` 和 `mobile` 不得互相导入源码。控制面只通过 `packages/protocol` 共享；版本清单只通过 `packages/update-contract` 共享。

## 平台扩展规则

1. 操作系统识别集中在平台目录。业务运行时只消费 `windows`、`macos`、`android`、`ios` 等领域名称。
2. 平台原生能力必须有接口和不支持时的明确行为。非 Android 平台不能在模块加载阶段要求 Android 原生模块存在。
3. 更新清单允许平台字段渐进加入，但已存在的平台字段保持向后兼容。
4. Apple 分发只能在 macOS/Xcode 环境完成。Windows 环境可验证 TypeScript、单元测试和脚本语法，不能验证签名包。
5. 平台凭据由系统安全存储保护。代码和文档不得把实现固定描述为 DPAPI；DPAPI 只是 Windows 后端。

## 变更放置

| 变更 | 目录 |
| --- | --- |
| 新的远程命令或事件 | `packages/protocol`，然后同步桌面与移动实现 |
| 新的更新清单字段 | `packages/update-contract`，然后同步发布器和客户端测试 |
| macOS 生命周期、可执行文件或系统能力 | `desktop/src/main/platform` |
| Android/iOS 更新行为 | `mobile/src/platform/update` |
| 原生系统调用 | `mobile/modules` 或桌面平台适配器 |
| 构建、签名、上传 | `appupdate/scripts` |

## 验证基线

```powershell
npm run typecheck
npm run test
npm run build
```

涉及某个平台的发布变更，还必须在该平台的真实工具链上完成打包、签名、安装、更新和回滚验证。
