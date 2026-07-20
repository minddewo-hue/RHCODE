/// <reference types="vite/client" />

import type { RhzycodeDesktopApi } from "../../preload";

declare global {
  interface Window {
    rhzycode: RhzycodeDesktopApi;
  }
}

export {};
