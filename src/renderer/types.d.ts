import type { Api } from "../preload/index";
import type { BuiPreload } from "./preloadAccess";

declare global {
  interface Window {
    api: Api;
    __buiPreload: BuiPreload | null;
  }
}

export {};
