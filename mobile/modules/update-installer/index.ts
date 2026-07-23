import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

interface DownloadResult {
  bytes: number;
  sha256: string;
}

interface UpdateInstallerModule {
  download(url: string, expectedBytes: number, expectedSha256: string): Promise<DownloadResult>;
  canInstallPackages(): Promise<boolean>;
  requestInstallPermission(): Promise<void>;
  installDownloaded(): Promise<void>;
}

const unsupportedInstaller: UpdateInstallerModule = {
  download: async () => { throw new Error("Direct package installation is only available on Android."); },
  canInstallPackages: async () => false,
  requestInstallPermission: async () => undefined,
  installDownloaded: async () => { throw new Error("Direct package installation is only available on Android."); },
};

export default Platform.OS === "android"
  ? requireNativeModule<UpdateInstallerModule>("UpdateInstaller")
  : unsupportedInstaller;
