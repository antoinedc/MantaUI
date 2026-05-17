import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MobileApp } from "./mobile/MobileApp";
import "./index.css";
import "./mobile/mobile.css";
import { httpApi } from "./api/httpApi";

// No Electron preload → this is the mobile/web client. Install the HTTP shim
// and render the mobile-native shell. Electron (preload set window.api) keeps
// the desktop <App/> exactly as before — desktop cannot reach mobile code.
const isMobile = !(window as unknown as { api?: unknown }).api;
if (isMobile) {
  (window as unknown as { api: unknown }).api = httpApi;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isMobile ? <MobileApp /> : <App />}</React.StrictMode>,
);
