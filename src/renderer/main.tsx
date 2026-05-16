import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { httpApi } from "./api/httpApi";

if (!(window as unknown as { api?: unknown }).api) {
  (window as unknown as { api: unknown }).api = httpApi;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
