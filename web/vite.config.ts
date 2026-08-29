import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Lets the dev server call relative /api/v1/... paths without CORS
      // fuss, mirroring how a single reverse-proxied origin would look in
      // a real deployment.
      "/api/v1": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
});
