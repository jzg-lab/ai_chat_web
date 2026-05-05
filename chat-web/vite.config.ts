import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/chat/",
  server: {
    port: 5173,
    proxy: {
      "/chat-api": "http://localhost:3000",
      "/chat-assets": "http://localhost:3000"
    }
  }
});
