import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPackagePath = path.resolve(__dirname, "..", "package.json");
const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf-8"));
const appVersion = rootPackage.version || "0.0.0";

export default defineConfig({
  plugins: [react()],
  define: {
    __CCM_CLIENT_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:3456",
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
            socket.on("error", (err) => {
              if (err.code !== "EPIPE") console.error("[ws proxy]", err.message);
            });
          });
          proxy.on("error", (err, _req, res) => {
            if (err.code === "EPIPE") return;
            console.error("[proxy error]", err.message);
            if (res?.writeHead) res.writeHead(502).end("Proxy error");
          });
        },
      },
      "/api": {
        target: "http://localhost:3456",
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
