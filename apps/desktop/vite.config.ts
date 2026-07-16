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
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
