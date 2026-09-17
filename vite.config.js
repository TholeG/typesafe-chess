import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React client lives in client/ and is built into dist/, which server.js serves.
// `npm run dev` runs Vite with hot reload and proxies /api to the Express server.
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
});
