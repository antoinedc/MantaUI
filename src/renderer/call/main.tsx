// call/main.tsx — entry for the floating on-call CTO window (BET-1166).
//
// A deliberately small, self-contained React root distinct from the main app
// (src/renderer/main.tsx). It does NOT pull in the app-wide store or httpApi:
// it only needs window.__mantaPreload.call to fetch its {serverUrl, boxToken}
// (to open the /call WS) and to show/park/hang the window. Audio + events ride
// the /call WS; the OpenAI key never reaches this window.

import React from "react";
import ReactDOM from "react-dom/client";
import { CallApp } from "./CallApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CallApp />
  </React.StrictMode>,
);
