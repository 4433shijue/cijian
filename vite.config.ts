import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || "./",
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules")) return "vendor";
          if (/[\\/]src[\\/](theater|theater-|FreeTheater|Theater)/.test(id)) return "theater";
          if (/[\\/]src[\\/](backup|backup-|transfer|TransferPanels|work-export)/.test(id)) return "transfer";
          return undefined;
        },
      },
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
} as any);
