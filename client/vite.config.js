import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ["monitor.xiangpan.org", "claude.xiangpan.org", "claude-dev.xiangpan.org"],
    proxy: {
      "/ws/ssh": {
        target: process.env.CCM_HTTPS ? "wss://localhost:3456" : "ws://localhost:3456",
        ws: true,
        secure: false, // accept self-signed certs
      },
      "/ws": {
        target: process.env.CCM_HTTPS ? "wss://localhost:3456" : "ws://localhost:3456",
        ws: true,
        secure: false,
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
        target: process.env.CCM_HTTPS ? "https://localhost:3456" : "http://localhost:3456",
        secure: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
