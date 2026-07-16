import "@vault/design-tokens/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { bootstrap } from "./state/store.js";

const root = createRoot(document.getElementById("root")!);

// Platform + persisted state must exist before the first render; bootstrap
// swaps the screen from "boot" when it finishes.
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void bootstrap();
