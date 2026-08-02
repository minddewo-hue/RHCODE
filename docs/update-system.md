# RHZYCODE 更新系统

Windows 和 Android 使用中转服务提供的统一更新清单：

```text
http://218.201.210.211:8000/v1/updates/manifest
```

当前 publisher 只发布 `windows` 和 `android`。清单 schema 以 `packages/update-contract` 为准。

## 文件布局

本地暂存目录：

```text
transferserver/updates/
  version.json
  windows/
    latest.yml
    RHZYCODE-Setup-<version>-x64.exe
    RHZYCODE-Setup-<version>-x64.exe.blockmap
  android/
    RHZYCODE-Android-<version>.apk
```

远程目录和 SSH 目标由 `appupdate/config.json` 定义，不在多份文档中重复维护。

## 客户端行为

### Windows

1. 读取统一清单。
2. 比较桌面版本。
3. 将 electron-updater feed 设置为清单中的 Windows feed。
4. 下载、校验并在用户确认后安装重启。

### Android

1. 冷启动或设置页手动读取统一清单。
2. 同时比较可见版本和 `versionCode`。
3. 下载 APK，校验字节数和 SHA-256。
4. 调用系统安装器；返回应用后可再次尝试。

当前版本不低于清单版本时不提示更新。

## 完整发布

### 1. 递增版本

按 [发布流程](release.md) 同步桌面版本、移动版本和 Android `versionCode`。

### 2. 验证

```powershell
npm run check
npm run build
```

### 3. 构建并本地暂存

```powershell
npm run update:release
```

等价于：

```powershell
npm run update:build:desktop
npm run update:build:mobile
npm run update:publish
```

`update:publish` 只复制本地产物并原子写入本地 `version.json`，不执行网络上传。

只更新一个平台时，可在产物已经存在的前提下运行：

```powershell
node appupdate/scripts/publish.mjs --platform=windows
node appupdate/scripts/publish.mjs --platform=android
```

单平台暂存会保留清单中另一个平台的现有项。

### 4. 检查本地清单

```powershell
Get-Content transferserver/updates/version.json
Get-Content desktop/release/release-manifest.json
```

确认版本、文件名、字节数和 SHA-256 与新产物一致。

### 5. 远程部署

```powershell
npm run update:deploy
```

部署脚本使用 SSH key：

1. 创建远程平台目录。
2. 上传安装包、blockmap 和 `latest.yml`。
3. 最后上传临时清单并原子替换 `version.json`。

清单最后切换可防止客户端读取到尚未完成上传的版本。

## 公网验证

```powershell
$manifest = Invoke-RestMethod http://218.201.210.211:8000/v1/updates/manifest
$manifest | ConvertTo-Json -Depth 6

curl.exe -fsSI http://218.201.210.211:8000/updates/windows/RHZYCODE-Setup-<version>-x64.exe
curl.exe -fsSI http://218.201.210.211:8000/updates/android/RHZYCODE-Android-<version>.apk
```

还要在远程主机运行 `sha256sum`，与清单比较。HTTP 必须返回 `200`，`Content-Length` 必须与清单 `bytes` 一致。

## 失败处理

- 构建失败：不执行 publish/deploy，保留旧远程清单。
- 本地暂存失败：修复缺失产物后重新执行 `update:publish`。
- 文件上传失败：重新执行 deploy；旧清单仍指向旧版本。
- 清单切换后发现问题：构建更高版本修复包。不要覆盖 immutable URL 下的同名文件。
- 客户端校验失败：核对远程文件长度、SHA-256、代理缓存和清单。

## 安全要求

- 正式 Windows/Android 包使用生产签名。
- SSH 只使用密钥认证，不在脚本或文档保存密码。
- 安装包 URL 不包含凭据。
- 当前公网 origin 使用 HTTP，无法防止更新包被链路篡改；客户端哈希校验不能替代 HTTPS 和代码签名。
