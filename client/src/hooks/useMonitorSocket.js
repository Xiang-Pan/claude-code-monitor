import { useState, useEffect, useRef, useCallback } from "react";

export function useMonitorSocket() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [pollIntervalMs, setPollIntervalMs] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hookEvents, setHookEvents] = useState([]);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    // Determine WebSocket URL based on current page location
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ws] Connected");
      setConnected(true);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "state") {
          setState(msg.data);
          setLastUpdated(Date.now());
          if (msg.data.pollIntervalMs) {
            setPollIntervalMs(msg.data.pollIntervalMs);
          }
        } else if (msg.type === "hook") {
          setHookEvents((prev) => [msg.data, ...prev].slice(0, 200));
        }
      } catch (err) {
        console.error("[ws] Parse error:", err);
      }
    };

    ws.onclose = () => {
      console.log("[ws] Disconnected, reconnecting in 3s...");
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      console.error("[ws] Error:", err);
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  const requestRefresh = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "refresh" }));
    }
  }, []);

  return { state, connected, pollIntervalMs, lastUpdated, requestRefresh, hookEvents };
}
