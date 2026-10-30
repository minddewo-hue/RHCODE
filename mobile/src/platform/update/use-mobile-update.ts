import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import UpdateInstaller from "../../../modules/update-installer";
import {
  fetchMobileUpdate,
  initialMobileUpdateStatus,
  recoverMobileUpdateAfterInstaller,
  type AndroidUpdate,
  type MobileUpdate,
  type MobileUpdatePlatform,
  type MobileUpdateStatus,
} from "./mobile-update";
import { createMobileUpdateCheckRuntime, type MobileUpdateCheckRuntime } from "./mobile-update-check-runtime";

interface MobileUpdateControllerOptions {
  currentVersion: string;
  currentBuildNumber: string;
  manifestUrl: string;
}

export function useMobileUpdate(options: MobileUpdateControllerOptions): {
  status: MobileUpdateStatus;
  check: (announce: boolean) => Promise<void>;
  install: (update: MobileUpdate) => Promise<void>;
} {
  const platform = mobileUpdatePlatform();
  const [status, setStatus] = useState<MobileUpdateStatus>(initialMobileUpdateStatus);
  const checkRuntime = useRef<MobileUpdateCheckRuntime | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const pendingInstallPermission = useRef<AndroidUpdate | null>(null);
  const installPermissionScreenOpened = useRef(false);
  const downloadedUpdate = useRef<AndroidUpdate | null>(null);
  const installInFlight = useRef(false);
  const pendingSystemInstaller = useRef<AndroidUpdate | null>(null);
  const systemInstallerScreenOpened = useRef(false);

  const installDownloadedUpdate = useCallback(async (update: AndroidUpdate) => {
    pendingSystemInstaller.current = update;
    systemInstallerScreenOpened.current = false;
    setStatus({ state: "installing", latest: update, error: null });
    try {
      await UpdateInstaller.installDownloaded();
    } catch (error) {
      pendingSystemInstaller.current = null;
      systemInstallerScreenOpened.current = false;
      throw error;
    }
  }, []);

  const install = useCallback(async (update: MobileUpdate) => {
    if (update.platform === "ios") {
      try {
        await Linking.openURL(update.storeUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法打开 App Store。";
        setStatus({ state: "error", latest: update, error: message });
        Alert.alert("无法打开 App Store", message);
      }
      return;
    }

    if (installInFlight.current) return;
    installInFlight.current = true;
    try {
      const alreadyDownloaded = downloadedUpdate.current?.versionCode === update.versionCode
        && downloadedUpdate.current.sha256 === update.sha256;
      if (!alreadyDownloaded) {
        setStatus({ state: "downloading", latest: update, error: null });
        await UpdateInstaller.download(update.downloadUrl, update.bytes, update.sha256);
        downloadedUpdate.current = update;
      }
      if (await UpdateInstaller.canInstallPackages()) {
        await installDownloadedUpdate(update);
        return;
      }
      pendingInstallPermission.current = update;
      installPermissionScreenOpened.current = false;
      setStatus({ state: "awaiting_permission", latest: update, error: null });
      await UpdateInstaller.requestInstallPermission();
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新下载或安装失败。";
      setStatus({ state: "error", latest: update, error: message });
      Alert.alert("无法安装更新", message);
    } finally {
      installInFlight.current = false;
    }
  }, [installDownloadedUpdate]);

  useEffect(() => {
    if (platform !== "android") return undefined;
    const subscription = AppState.addEventListener("change", (appState) => {
      if (pendingInstallPermission.current) {
        if (appState !== "active") {
          installPermissionScreenOpened.current = true;
        } else if (installPermissionScreenOpened.current) {
          const update = pendingInstallPermission.current;
          pendingInstallPermission.current = null;
          installPermissionScreenOpened.current = false;
          void UpdateInstaller.canInstallPackages().then(async (allowed) => {
            if (!allowed) {
              setStatus({ state: "ready_to_install", latest: update, error: null });
              Alert.alert("需要安装权限", "请允许 RHZYCODE 安装未知应用，然后再次点击安装。");
              return;
            }
            await installDownloadedUpdate(update);
          }).catch((error) => {
            const message = error instanceof Error ? error.message : "无法继续安装更新。";
            setStatus({ state: "error", latest: update, error: message });
            Alert.alert("无法安装更新", message);
          });
        }
      }

      if (!pendingSystemInstaller.current) return;
      if (appState !== "active") {
        systemInstallerScreenOpened.current = true;
        return;
      }
      if (!systemInstallerScreenOpened.current) return;
      pendingSystemInstaller.current = null;
      systemInstallerScreenOpened.current = false;
      setStatus(recoverMobileUpdateAfterInstaller);
    });
    return () => subscription.remove();
  }, [installDownloadedUpdate, platform]);

  const check = useCallback((automatic: boolean) => (
    checkRuntime.current?.check(automatic) || Promise.resolve()
  ), []);

  useEffect(() => {
    if (!platform) return undefined;
    const runtime = createMobileUpdateCheckRuntime({
      load: () => fetchMobileUpdate(options.currentVersion, {
        platform,
        manifestUrl: options.manifestUrl,
        currentVersionCode: platform === "android" ? Number(options.currentBuildNumber) : undefined,
        currentBuildNumber: platform === "ios" ? options.currentBuildNumber : undefined,
      }),
      readAppState: () => AppState.currentState,
      canCheck: () => !installInFlight.current
        && !pendingInstallPermission.current
        && !pendingSystemInstaller.current
        && !["downloading", "ready_to_install", "awaiting_permission", "installing"].includes(statusRef.current.state),
      onChecking: () => setStatus((current) => ({ state: "checking", latest: current.latest, error: null })),
      onResult: setStatus,
      onCurrent: () => Alert.alert("当前版本已是最新"),
      onError: (error) => setStatus((current) => ({
        state: "error",
        latest: current.latest,
        error: error instanceof Error ? error.message : "无法检查更新。",
      })),
      onAvailable: (update) => {
        Alert.alert(
          "发现新版本",
          `RHZYCODE ${update.version} 已可用。`,
          [
            { text: "稍后", style: "cancel" },
            {
              text: update.platform === "ios" ? "前往 App Store" : "下载并安装",
              onPress: () => void install(update),
            },
          ],
        );
      },
    });
    checkRuntime.current = runtime;
    const subscription = AppState.addEventListener("change", runtime.appStateChanged);
    return () => {
      subscription.remove();
      runtime.dispose();
      if (checkRuntime.current === runtime) checkRuntime.current = null;
    };
  }, [install, options.currentBuildNumber, options.currentVersion, options.manifestUrl, platform]);

  return { status, check, install };
}

function mobileUpdatePlatform(): MobileUpdatePlatform | null {
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "ios") return "ios";
  return null;
}
