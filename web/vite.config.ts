import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.KELLY_API ?? "http://127.0.0.1:8787";
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy: { "/api": api, "/sellers": api, "/webhooks": api } },
});
