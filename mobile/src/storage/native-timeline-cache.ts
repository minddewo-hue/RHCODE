import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { ThreadTimelineCacheStore, type TextFileAdapter } from "./timeline-cache";

const webValues = new Map<string, string>();

function cacheFileName(connectionId: string): string {
  const safe = connectionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "default";
  return `timeline-cache-v1.${safe}.json`;
}

/**
 * expo-file-system backed cache (one JSON file per connection, in the app
 * cache directory — cleared with the app's cache, never holds secrets).
 */
export function createNativeTimelineCacheStore(connectionId: string): ThreadTimelineCacheStore {
  const key = cacheFileName(connectionId);
  if (Platform.OS === "web") {
    return new ThreadTimelineCacheStore({
      async read() {
        return webValues.get(key) ?? null;
      },
      async write(text) {
        webValues.set(key, text);
      },
    });
  }
  const adapter: TextFileAdapter = {
    async read() {
      const file = new File(new Directory(Paths.cache, "RHZYCODE"), key);
      if (!file.exists) return null;
      try {
        return file.textSync();
      } catch {
        return null;
      }
    },
    async write(text) {
      const file = new File(new Directory(Paths.cache, "RHZYCODE"), key);
      if (!file.exists) file.create({ intermediates: true, overwrite: true });
      file.write(text);
    },
  };
  return new ThreadTimelineCacheStore(adapter);
}
