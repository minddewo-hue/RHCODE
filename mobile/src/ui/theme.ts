import * as SecureStore from "expo-secure-store";
import { Appearance, StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from "react-native";

export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  canvas: string;
  surface: string;
  sidebar: string;
  subtle: string;
  pressed: string;
  border: string;
  borderStrong: string;
  ink: string;
  inkMuted: string;
  inkFaint: string;
  inverse: string;
  /** Filled chip/button background that stays contrasted in both themes. */
  solid: string;
  /** Foreground on `solid` surfaces. */
  onSolid: string;
  badge: string;
  onBadge: string;
  accent: string;
  accentSoft: string;
  primaryAction: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  overlay: string;
  userBubble: string;
  userBubbleBorder: string;
  preview: string;
  previewControl: string;
  previewControlPressed: string;
  shadow: string;
}

export const lightColors: ThemeColors = {
  canvas: "#fbfbfa", surface: "#ffffff", sidebar: "#f2f2ef", subtle: "#f5f5f3", pressed: "#e9e9e5",
  border: "#deded9", borderStrong: "#c9c9c2", ink: "#20201e", inkMuted: "#6e6e68", inkFaint: "#989890",
  inverse: "#ffffff", solid: "#20201e", onSolid: "#ffffff", badge: "#d5d9d6", onBadge: "#171a18",
  accent: "#167052", accentSoft: "#e5f3ed", primaryAction: "#1f1f1f", warning: "#9a5b13", warningSoft: "#fff3dd",
  danger: "#b33b32", dangerSoft: "#fbe9e7", info: "#36658d", infoSoft: "#e9f1f8", overlay: "rgba(24, 24, 22, 0.32)",
  userBubble: "#90dd65", userBubbleBorder: "#69bd43", preview: "#101310ee", previewControl: "#ffffff1f",
  previewControlPressed: "#ffffff38", shadow: "#000000",
};

export const darkColors: ThemeColors = {
  canvas: "#171a18", surface: "#202421", sidebar: "#1c201d", subtle: "#282d29", pressed: "#303631",
  border: "#343a35", borderStrong: "#4a524b", ink: "#edf1ed", inkMuted: "#aab2ab", inkFaint: "#7d867e",
  inverse: "#ffffff", solid: "#dce4dd", onSolid: "#172019", badge: "#c8ceca", onBadge: "#141714",
  accent: "#71bc91", accentSoft: "#213b2e", primaryAction: "#41644f", warning: "#e0b467", warningSoft: "#3d3220",
  danger: "#ee8e84", dangerSoft: "#412925", info: "#86b4dc", infoSoft: "#243544", overlay: "rgba(0, 0, 0, 0.62)",
  userBubble: "#315d3c", userBubbleBorder: "#4b8a5b", preview: "#080a09f2", previewControl: "#ffffff24",
  previewControlPressed: "#ffffff40", shadow: "#000000",
};

const THEME_STORAGE_KEY = "rhzycode.theme-mode";
let activeThemeMode: ThemeMode = "light";

export const colors = new Proxy({} as ThemeColors, {
  get: (_target, property: keyof ThemeColors) => (
    activeThemeMode === "dark" ? darkColors[property] : lightColors[property]
  ),
});

export function setActiveThemeMode(mode: ThemeMode): void {
  activeThemeMode = mode;
  Appearance.setColorScheme(mode);
}

export async function loadThemeMode(): Promise<ThemeMode> {
  try {
    return await SecureStore.getItemAsync(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  try {
    await SecureStore.setItemAsync(THEME_STORAGE_KEY, mode);
  } catch {
    // Theme persistence is optional when secure storage is unavailable.
  }
}

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

export function createThemedStyles<T extends NamedStyles<T>>(factory: (palette: ThemeColors) => T): T {
  const sheets = {
    light: StyleSheet.create(factory(lightColors)),
    dark: StyleSheet.create(factory(darkColors)),
  };
  return new Proxy(sheets.light as T, {
    get: (_target, property: string | symbol) => sheets[activeThemeMode][property as keyof T],
  });
}
