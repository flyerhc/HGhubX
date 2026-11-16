import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { legacyCss } from "./scripts/legacy-css";

const host = process.env.TAURI_DEV_HOST;
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig(({ mode }) => {
  const edition = process.env.VITE_APP_EDITION || loadEnv(mode, process.cwd(), "VITE_").VITE_APP_EDITION;
  return {
  resolve: { alias: { "@edition-bootstrap": fileURLToPath(new URL(edition === "tv" ? "./src/tv/bootstrap.tsx" : "./src/standardBootstrap.tsx", import.meta.url)) } },
  plugins: [react(), tailwindcss({ optimize: false }), legacyCss()],
  clearScreen: false,
  // 版本号只维护 package.json（CI 会按 tag 改写它），界面里的版本由这里注入，避免写死后漂移
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: ["chrome66", "safari14.1"],
    cssTarget: ["chrome66", "safari13"],
    cssCodeSplit: false,
    // legacyCss performs the final minification after compatibility transforms.
    cssMinify: false,
    minify: "esbuild",
    sourcemap: false,
  },
  };
});
