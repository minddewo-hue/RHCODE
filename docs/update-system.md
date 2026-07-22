# RHZYCODE 本地升级系统

本文档说明 RHZYCODE 桌面端与 Android 端的自动更新功能、发布流程、更新服务接口和故障排查。当前更新服务器部署在开发电脑上，只服务可信局域网。

## 1. 当前配置

| 项目 | 当前值 |
| --- | --- |
| 服务监听地址 | `0.0.0.0:8791` |
| 局域网地址 | `http://192.168.11.103:8791` |
| 桌面更新通道 | `http://192.168.11.103:8791/desktop` |
| Android 更新清单 | `http://192.168.11.103:8791/manifest.json` |
| 当前桌面版本 | `0.1.7` |
| 当前 Android 版本 | `0.1.10`，`versionCode = 11` |
| 服务启动方式 | 手动启动，不注册计划任务或登录自启动 |

服务配置来源为 `appupdate/config.json`。如果电脑的固定 IP 或端口发生变化，必须同步检查以下位置，然后重新构建两端安装包：

- `appupdate/config.json`：服务监听端口和对外基础 URL。
- `appupdate/scripts/build-desktop.mjs`：桌面 Release 的更新通道。
- `desktop/src/main/index.ts`：桌面运行时的默认更新通道。
- `appupdate/scripts/build-mobile.mjs`：Android Release 构建变量。
- `mobile/app.json`：Android 内置的更新清单 URL。

## 2. 检查策略

### 2.1 桌面端

- 每次程序启动约 10 秒后检查一次，不受时间段限制。
- 程序保持运行时，每 2 小时触发一次定时检查。
- 定时检查只在电脑本地时间 `10:00`（含）到 `20:00`（不含）执行，即最后有效时间为 `19:59`。
- 用户可随时在桌面端设置栏手动检查、下载和安装更新。
- 下载完成后，由用户确认重启并安装。

桌面更新状态由 `desktop/src/main/update-manager.ts` 管理，底层使用 `electron-updater`。当前版本与服务端版本相同时显示“没有可用更新”。

### 2.2 Android 端

- 每次冷启动约 3 秒后只检查一次。
- 切换前后台不会再次检查。
- 不执行 30 分钟或其他周期检查。
- 用户可在“设置 -> 版本更新”中随时手动检查。
- 发现新版本后，点击下载会交给 Android 浏览器或系统下载器处理 APK；安装时由 Android 系统确认。

移动端更新逻辑位于 `mobile/src/update/mobile-update.ts`，启动调用位于 `mobile/src/App.tsx`。

## 3. 目录和产物

```text
appupdate/
  config.json                       服务地址与端口
  server.mjs                        HTTP 更新服务
  channel.json                      当前发布清单
  scripts/
    build-desktop.mjs               桌面 Release 构建
    build-mobile.mjs                Android Release 构建
    publish.mjs                     复制产物并生成 channel.json
    gradle-no-proxy.init.gradle     仅本次构建使用的 Gradle 代理隔离
  artifacts/
    desktop/
      latest.yml
      RHZYCODE-Setup-<version>-x64.exe
      RHZYCODE-Setup-<version>-x64.exe.blockmap
    mobile/
      RHZYCODE-Android-<version>.apk
```

原始构建产物位置：

- 桌面端：`desktop/release/`
- Android：`mobile/android/app/build/outputs/apk/release/app-release.apk`
- 对外发布目录：`appupdate/artifacts/`

`update:publish` 会计算文件大小和 SHA-256，并写入 `appupdate/channel.json`。桌面端的 `latest.yml` 还包含 `electron-updater` 使用的 SHA-512 和 blockmap 信息。

## 4. 构建环境

### 4.1 通用要求

- Windows 10/11。
- Node.js 20 或更高版本。
- npm 11.x；仓库固定为 `npm@11.6.2`。
- 从仓库根目录 `D:\work_space\test` 执行命令。

### 4.2 Android 要求

- Android SDK：`D:\android_sdk`。
- NDK：`D:\android_sdk\ndk\27.1.12297006`。
- 当前机器还安装了 NDK `25.1.8937393` 和 `29.0.14206865`，但 Expo/React Native Release 使用 `27.1.12297006`。
- `appupdate/scripts/build-mobile.mjs` 默认设置 `ANDROID_HOME` 和 `ANDROID_SDK_ROOT` 为 `D:\android_sdk`，并固定 `NODE_ENV=production`。

Gradle 全局配置中若存在无效代理，构建脚本会通过 `gradle-no-proxy.init.gradle` 只为本次构建清除代理系统属性，不修改用户的全局 Gradle 文件。

## 5. 发布新版本

### 5.1 修改版本号

发布前必须同时修改：

1. `desktop/package.json` 中的 `version`。
2. `mobile/app.json` 中的 `expo.version`。
3. `mobile/app.json` 中的 `expo.android.versionCode`。

Android 的 `versionCode` 必须比已发布版本大，且只能使用整数。例如从 `0.1.0 (1)` 升级到 `0.1.1 (2)`：

```json
{
  "expo": {
    "version": "0.1.1",
    "android": {
      "versionCode": 2
    }
  }
}
```

桌面端和 Android 可以使用相同的可见版本号，便于管理，但它们是独立更新通道。

### 5.2 一次完成两端构建和发布

```powershell
Set-Location D:\work_space\test
npm run update:release
```

该命令依次执行：

```text
update:build:desktop
  -> update:build:mobile
  -> update:publish
```

构建时间较长，Android 首次构建还可能下载或编译原生依赖。任何一步失败时不会继续发布后续产物。

### 5.3 分开构建

需要单独排查或只更新一端时：

```powershell
npm run update:build:desktop
npm run update:build:mobile
npm run update:publish
```

`update:publish` 要求桌面安装包、blockmap、`latest.yml` 和 Android APK 都已存在。如果只构建一端，它仍会把另一端已有的 Release 产物一起发布，因此发布前应核对版本和文件时间。

## 6. 启动更新服务

手动启动：

```powershell
Set-Location D:\work_space\test
npm run update:serve
```

服务必须保持运行，桌面端和手机端才能检查或下载更新。关闭该终端或结束 Node 进程后，更新服务停止，但不影响桌面控制服务 `8790` 和已经安装的客户端使用。

当前不安装 Windows 计划任务，不写入 `HKCU Run`。如以后需要无人值守运行，推荐使用 WinSW 或 NSSM 注册为 Windows Service，并以低权限专用账户运行；不要把局域网 HTTP 服务直接映射到公网。

## 7. 服务接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康状态 |
| `GET` | `/manifest.json` | 桌面与 Android 统一清单 |
| `GET` | `/desktop/latest.yml` | `electron-updater` 通道元数据 |
| `GET`/`HEAD` | `/desktop/<file>` | 桌面安装包与 blockmap |
| `GET`/`HEAD` | `/mobile/<file>` | Android APK |

安装包接口支持 HTTP byte range。浏览器、系统下载器和 `electron-updater` 可以使用断点下载，正确的范围请求返回 `206 Partial Content`。

常用检查：

```powershell
Invoke-RestMethod http://192.168.11.103:8791/health
Invoke-RestMethod http://192.168.11.103:8791/manifest.json
curl.exe -I http://192.168.11.103:8791/desktop/latest.yml
curl.exe -I http://192.168.11.103:8791/mobile/RHZYCODE-Android-0.1.0.apk
curl.exe -D - -o NUL -H "Range: bytes=0-31" http://192.168.11.103:8791/mobile/RHZYCODE-Android-0.1.0.apk
```

## 8. 发布后验证

每次发布至少完成以下检查：

```powershell
npm run check
npm test --workspace @rhzycode/appupdate
```

然后验证：

1. `/health` 返回 `{"status":"ok"}`。
2. `/manifest.json` 中的版本、`versionCode`、URL、大小和 SHA-256 正确。
3. `/desktop/latest.yml` 的版本与桌面安装包一致。
4. APK 的 `Content-Length` 与清单大小一致，Range 请求返回 `206`。
5. 桌面端启动后能显示“当前已是最新版本”或新版本状态。
6. Android 冷启动后，在“设置 -> 版本更新”中看到正确状态。
7. Android 覆盖安装成功，且原有连接 KEY 和应用数据没有丢失。

本机 APK 校验示例：

```powershell
$apk = "appupdate\artifacts\mobile\RHZYCODE-Android-0.1.0.apk"
& "D:\android_sdk\build-tools\36.1.0\apksigner.bat" verify --verbose --print-certs $apk
& "D:\android_sdk\build-tools\36.1.0\aapt.exe" dump badging $apk
Get-FileHash $apk -Algorithm SHA256
```

Android 覆盖安装与启动：

```powershell
& "D:\android_sdk\platform-tools\adb.exe" install -r mobile\android\app\build\outputs\apk\release\app-release.apk
& "D:\android_sdk\platform-tools\adb.exe" shell am force-stop ai.rhzy.code
& "D:\android_sdk\platform-tools\adb.exe" shell monkey -p ai.rhzy.code -c android.intent.category.LAUNCHER 1
```

## 9. 签名与安全

### 9.1 桌面端

当前本机通道允许在明确启用 `RHZYCODE_ALLOW_UNSIGNED_LOCAL_UPDATES=1` 时构建未签名包，但只接受 localhost 或 RFC1918 私有地址。`appupdate/scripts/build-desktop.mjs` 已为本机通道设置该变量。

公开或生产更新必须使用受信任的 Authenticode 证书和 HTTPS。不要把未签名例外扩展到公网域名。

### 9.2 Android

Android 只允许使用相同签名证书覆盖安装。当前构建保留了现有应用使用的签名，因此 `adb install -r` 可以保留数据。切换正式 release keystore 后必须安全备份 keystore 和密码；丢失签名密钥将无法为现有安装提供覆盖升级。

APK 下载通过系统浏览器或下载器完成。Android 安装器会检查应用签名一致性；`manifest.json` 同时提供 SHA-256，供发布验证和人工核对。

### 9.3 网络边界

- `8791` 当前为局域网 HTTP，只能在可信 WLAN 内使用。
- 更新目录不得包含 `.env`、Provider KEY、移动连接 KEY、Codex `auth.json`、证书私钥或用户状态。
- 需要跨公网发布时，应改为 HTTPS、代码签名、访问控制和独立发布服务器。

## 10. 常见问题

### 客户端无法检查更新

1. 确认更新服务终端仍在运行。
2. 访问 `http://192.168.11.103:8791/health`。
3. 确认电脑仍使用 `192.168.11.103`。
4. 确认手机和电脑在同一可信局域网。
5. 检查 Windows 防火墙是否允许 Node.js 监听 `8791`。

### 发布后仍显示当前版本

- 检查是否提升了 `desktop/package.json` 的版本。
- 检查 Android 的 `expo.version` 和 `expo.android.versionCode` 是否都已提升。
- 重新执行 `npm run update:publish`。
- 检查服务返回的 `manifest.json` 和 `desktop/latest.yml`，不要只查看构建目录。

### Android 报签名不兼容

出现 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 通常表示新旧 APK 的签名证书不同。应恢复原签名重新打包；卸载旧应用虽然可以安装，但会清除本机应用数据和已保存 KEY，不应作为正常升级方案。

### Android 构建找不到 NDK

确认以下文件存在：

```text
D:\android_sdk\ndk\27.1.12297006\source.properties
```

其中 `Pkg.Revision` 必须为 `27.1.12297006`。不要只创建同名空目录。

### 下载不完整或中断

使用 `curl.exe -I` 检查 `Content-Length`，再用 Range 示例确认返回 `206`。如果重新发布了同名文件，应等待当前下载结束后再覆盖，或提升版本号生成新文件名。

## 11. 发布检查清单

- [ ] 桌面 `version` 已提升。
- [ ] Android `version` 已提升。
- [ ] Android `versionCode` 已递增。
- [ ] `npm run update:release` 成功。
- [ ] `npm run check` 全部通过。
- [ ] 安装包签名和哈希已校验。
- [ ] `channel.json`、`manifest.json`、`latest.yml` 版本一致。
- [ ] 桌面自动检查已验证。
- [ ] Android 冷启动检查已验证。
- [ ] 桌面下载与安装流程已验证。
- [ ] Android 覆盖安装并保留数据已验证。
