import "@vault/design-tokens/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AdminApp } from "./screens/admin/AdminApp.js";
import { bootstrap } from "./state/store.js";

/**
 * One bundle, two entry points. The admin console runs in its own OS window
 * (label "admin", declared hidden in tauri.conf.json with url
 * `index.html?window=admin`) so nothing admin-related shares state or
 * capabilities with the normal app. The query string is what that window
 * carries in both Tauri and browser dev.
 */
const isAdminWindow = new URLSearchParams(location.search).get("window") === "admin";

const root = createRoot(document.getElementById("root")!);

if (isAdminWindow) {
  root.render(
    <StrictMode>
      <AdminApp />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void bootstrap();
}
