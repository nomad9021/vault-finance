import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed dev port; `clearScreen: false` keeps Rust build
  // output visible when running `tauri dev`.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Dev-only: browsers won't talk to the server's self-signed cert, so proxy
    // the API through Vite. Point the connect screen at http://localhost:5173
    // to preview the real UI in a browser. Tauri builds never use this.
    proxy: {
      "/api": {
        target: process.env.VAULT_SERVER ?? "https://localhost:8443",
        changeOrigin: true,
        secure: false,
      },
      // The shared design system and the phone viewer, so both platforms can
      // be previewed side by side in one browser during a redesign.
      "/vault.css": {
        target: process.env.VAULT_SERVER ?? "https://localhost:8443",
        changeOrigin: true,
        secure: false,
      },
      "/phone": {
        target: process.env.VAULT_SERVER ?? "https://localhost:8443",
        changeOrigin: true,
        secure: false,
        rewrite: () => "/",
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
