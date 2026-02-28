import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
