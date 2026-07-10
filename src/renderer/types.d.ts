import type { Api } from "../shared/api";
import type { BuiPreload } from "./preloadAccess";

declare global {
  interface Window {
    api: Api;
    __buiPreload: BuiPreload | null;
  }
}

export {};
