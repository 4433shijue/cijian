import { version } from "./package.json";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "release-version",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({
            version,
            commit: process.env.GITHUB_SHA || "local",
          }),
        });
      },
    } as Plugin,
  ],
  base: process.env.VITE_BASE_PATH || "./",
  server: {
    watch: {
      ignored: [
        "**/work/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/outputs/**",
        "**/examples/**",
      ],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/]fflate[\\/]/.test(id)) return "archive-vendor";
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        },
      },
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
} as any);
