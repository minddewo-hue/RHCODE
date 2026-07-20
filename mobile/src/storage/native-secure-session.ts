import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { SecureSessionStore, type SecureStorageAdapter } from "./secure-session";

const webValues = new Map<string, string>();

const ephemeralWebStorage: SecureStorageAdapter = {
  async getItemAsync(key) {
    return webValues.get(key) ?? null;
  },
  async setItemAsync(key, value) {
    webValues.set(key, value);
  },
  async deleteItemAsync(key) {
    webValues.delete(key);
  },
};

export function createNativeSecureSessionStore(): SecureSessionStore {
  const storage = Platform.OS === "web" ? ephemeralWebStorage : SecureStore;
  return new SecureSessionStore(storage);
}
