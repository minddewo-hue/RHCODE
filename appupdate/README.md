# Update Tooling

`appupdate` 保存 RHZYCODE 的平台构建、本地暂存和远程部署脚本。

## 命令

从仓库根目录运行：

```powershell
npm run update:build:desktop  # Windows installer
npm run update:build:mobile   # Android APK
npm run update:publish        # stage local windows/android files
npm run update:deploy         # upload staged files and switch manifest
npm run update:release        # build Windows + Android, then stage locally
```

macOS/iOS 构建入口：

```bash
npm run update:build:mac
npm run update:build:ios
```

当前 `publish.mjs` 只支持 Windows 和 Android。`update:release` 不包含远程部署。

## 配置

`config.json` 定义：

- 公网 origin。
- 本地 updates 目录。
- SSH 目标和远程项目目录。

配置不得包含 SSH 密码、私钥、签名密码或 Provider Key。部署使用操作系统已有的 SSH key 认证。

完整版本提升、签名、暂存、上传和公网校验流程见：

- [发布流程](../docs/release.md)
- [更新系统](../docs/update-system.md)
