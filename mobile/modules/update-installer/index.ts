import { requireNativeModule } from "expo-modules-core";

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

export default requireNativeModule<UpdateInstallerModule>("UpdateInstaller");
