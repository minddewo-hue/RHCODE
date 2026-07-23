import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import UpdateInstaller from "../../../modules/update-installer";
import {
  fetchMobileUpdate,
  initialMobileUpdateStatus,
  type AndroidUpdate,
  type MobileUpdate,
  type MobileUpdatePlatform,
  type MobileUpdateStatus,
} from "./mobile-update";

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
  const announcedVersion = useRef<string | null>(null);
  const pendingInstallPermission = useRef<AndroidUpdate | null>(null);
  const installPermissionScreenOpened = useRef(false);

  const installDownloadedUpdate = useCallback(async (update: AndroidUpdate) => {
    setStatus({ state: "installing", latest: update, error: null });
    await UpdateInstaller.installDownloaded();
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

    setStatus({ state: "downloading", latest: update, error: null });
    try {
      await UpdateInstaller.download(update.downloadUrl, update.bytes, update.sha256);
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
    }
  }, [installDownloadedUpdate]);

  useEffect(() => {
    if (platform !== "android") return undefined;
    const subscription = AppState.addEventListener("change", (appState) => {
      if (!pendingInstallPermission.current) return;
      if (appState !== "active") {
        installPermissionScreenOpened.current = true;
        return;
      }
      if (!installPermissionScreenOpened.current) return;
      const update = pendingInstallPermission.current;
      pendingInstallPermission.current = null;
      installPermissionScreenOpened.current = false;
      void UpdateInstaller.canInstallPackages().then(async (allowed) => {
        if (!allowed) {
          setStatus({ state: "available", latest: update, error: null });
          Alert.alert("需要安装权限", "请允许 RHZYCODE 安装未知应用，然后重新点击下载并安装。");
          return;
        }
        await installDownloadedUpdate(update);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "无法继续安装更新。";
        setStatus({ state: "error", latest: update, error: message });
        Alert.alert("无法安装更新", message);
      });
    });
    return () => subscription.remove();
  }, [installDownloadedUpdate, platform]);

  const check = useCallback(async (announce: boolean) => {
    if (!platform) return;
    setStatus((current) => ({ state: "checking", latest: current.latest, error: null }));
    try {
      const latestStatus = await fetchMobileUpdate(options.currentVersion, {
        platform,
        manifestUrl: options.manifestUrl,
        currentVersionCode: platform === "android" ? Number(options.currentBuildNumber) : undefined,
        currentBuildNumber: platform === "ios" ? options.currentBuildNumber : undefined,
      });
      setStatus(latestStatus);
      if (!announce && latestStatus.state === "current") Alert.alert("当前版本已是最新");
      if (announce
        && latestStatus.state === "available"
        && announcedVersion.current !== latestStatus.latest.version) {
        announcedVersion.current = latestStatus.latest.version;
        Alert.alert(
          "发现新版本",
          `RHZYCODE ${latestStatus.latest.version} 已可用。`,
          [
            { text: "稍后", style: "cancel" },
            {
              text: latestStatus.latest.platform === "ios" ? "前往 App Store" : "下载并安装",
              onPress: () => void install(latestStatus.latest),
            },
          ],
        );
      }
    } catch (error) {
      setStatus((current) => ({
        state: "error",
        latest: current.latest,
        error: error instanceof Error ? error.message : "无法检查更新。",
      }));
    }
  }, [install, options.currentBuildNumber, options.currentVersion, options.manifestUrl, platform]);

  useEffect(() => {
    if (!platform) return undefined;
    const initialCheck = setTimeout(() => void check(true), 3_000);
    return () => clearTimeout(initialCheck);
  }, [check, platform]);

  return { status, check, install };
}

function mobileUpdatePlatform(): MobileUpdatePlatform | null {
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "ios") return "ios";
  return null;
}
