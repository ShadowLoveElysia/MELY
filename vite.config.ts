import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const tauriHost = process.env.TAURI_DEV_HOST;
const tauriPlatform = process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  base: "./",
  clearScreen: false,
  plugins: [react()],
  // Schematic 是动态模块，预构建 Buffer 兼容层可避免首次导出时 Vite 重载应用。
  optimizeDeps: {
    include: ["buffer"],
  },
  server: {
    host: tauriHost || "127.0.0.1",
    port: 4173,
    strictPort: true,
    hmr: tauriHost
      ? {
          protocol: "ws",
          host: tauriHost,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: tauriPlatform === "windows"
      ? "chrome105"
      : tauriPlatform
        ? "safari13"
        : "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  // babylon-mmd ships worker modules that use code splitting. IIFE workers
  // cannot import those chunks, while ES workers can be bundled correctly by
  // Vite and loaded by both the web and Tauri runtimes.
  worker: {
    format: "es",
  },
});
