# 项目结构与依赖边界

## 目录

```text
desktop/
  src/main/                    Electron 主进程、Agent Host 和本地基础设施
  src/main/control-plane/      回环 HTTP/WS 控制面、事件存储和 KEY 管理
  src/main/platform/           桌面操作系统适配
  src/preload/                 renderer 的受限 IPC 桥
  src/renderer/                React 桌面界面
  src/shared/                  renderer/preload/main 共享桌面类型
  model-gateway/               Provider 与模型路由
  scripts/                     冒烟、打包和发布审计
  test/                        主进程、控制面和契约测试

mobile/
  src/api/                     中转控制 API 客户端
  src/auth/                    KEY 和连接模型
  src/components/              移动界面
  src/hooks/                   snapshot、事件连接和工作流
  src/platform/                Android/iOS 平台行为
  src/state/                   事件合并和项目列表
  src/storage/                 SecureStore 会话持久化
  src/ui/                      主题与视觉变量
  plugins/                     Expo config plugins
  test/                        协议、重连、存储和更新测试

transferserver/                公网中转和更新文件服务
  app.mjs                      Fastify 生命周期、安全 hook 与模块编排
  control-routes.mjs           HTTP/WS 控制请求代理
  relay-registry.mjs           在线桌面、事件连接与请求关联
  update-routes.mjs            更新清单和安装包文件服务
packages/protocol/             桌面与移动共享控制协议
packages/update-contract/      更新清单 schema 与版本比较
appupdate/                     构建、暂存和远程部署脚本
docs/                          项目规范、开发和运维文档
scripts/                       仓库级资源生成脚本
validation/                    独立验证样例和历史产物
```

## 依赖方向

```text
desktop ---------> packages/protocol
       `---------> packages/update-contract

mobile ----------> packages/protocol
       `---------> packages/update-contract

transferserver --> packages/update-contract
appupdate -------> packages/update-contract
```

规则：

- `packages/*` 不依赖应用目录。
- `desktop` 与 `mobile` 不互相导入源码。
- 桌面和移动只通过 `packages/protocol` 共享控制协议。
- 更新发布和消费只通过 `packages/update-contract` 共享清单格式。
- 中转服务不导入桌面运行时，也不实现 Codex 或业务状态。

## 变更放置

| 变更 | 首选位置 |
| --- | --- |
| Codex RPC 适配、任务生命周期 | `desktop/src/main` |
| 新桌面 IPC | `desktop/src/shared`、main、preload、renderer |
| 新远程命令或事件 | `packages/protocol`，再同步 desktop/mobile/tests |
| 中转路由、限流或部署 | `transferserver` |
| Provider、模型目录或健康检查 | `desktop/model-gateway`、`desktop/src/main/gateway-module.ts` |
| Android/iOS 更新行为 | `mobile/src/platform/update` |
| 移动原生配置 | `mobile/plugins` 或平台 module |
| 更新清单字段 | `packages/update-contract`，再同步发布器和客户端 |
| 构建、签名、暂存和上传 | `appupdate/scripts`、对应平台打包脚本 |
| 图标与品牌源文件 | `assets`、`scripts/generate-app-icons.ps1` |

## 跨边界变更顺序

1. 在共享 package 中定义当前 schema 和类型。
2. 同一变更内更新桌面权威实现与运行时校验。
3. 同一变更内更新移动客户端解析、状态和 UI。
4. 增加协议、桌面、移动和中转测试。
5. 桌面与手机安装包按同一协议版本发布，不在客户端保留旧协议猜测分支。
6. 更新对应主文档，不在多个文件复制完整接口表。

## 平台规则

- 操作系统识别集中在平台目录，业务层使用领域名称。
- 平台原生能力必须定义“不支持”行为。
- Expo prebuild 可能重写 `mobile/android` 与 `mobile/ios`；长期配置应优先放在 `mobile/app.json` 和 config plugin。
- Apple 构建只能在 macOS 完成；Windows 上的类型检查不能替代签名和真机验证。
- 凭据统一通过系统安全存储，不提供明文回退。

## 验证基线

```powershell
npm run typecheck
npm run test
npm run build
```

共享协议变化至少还要运行 desktop/mobile/transferserver 的相关测试。发布变化必须在目标平台完成构建、安装、升级、回滚和签名验证。
