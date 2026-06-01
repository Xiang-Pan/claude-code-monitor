import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

// ── Password prompt modal ────────────────────────────────────
function PasswordModal({ prompt = "SSH Password", onSubmit, onCancel }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(value);
    setValue("");
  };

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(2px)",
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: "#161b22", border: "1px solid #30363d", borderRadius: 10,
          padding: "28px 32px", minWidth: 320, display: "flex", flexDirection: "column", gap: 16,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🔑</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: "#e6edf3" }}>
            {prompt}
          </span>
        </div>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Enter password…"
          autoComplete="current-password"
          style={{
            padding: "9px 12px", borderRadius: 6, border: "1px solid #30363d",
            background: "#0d1117", color: "#e6edf3",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
            outline: "none",
          }}
          onFocus={(e) => { e.target.style.borderColor = "#58a6ff"; }}
          onBlur={(e) => { e.target.style.borderColor = "#30363d"; }}
        />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "7px 18px", borderRadius: 6, border: "1px solid #30363d",
              background: "none", color: "#8b949e", cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
            }}
          >Cancel</button>
          <button
            type="submit"
            style={{
              padding: "7px 18px", borderRadius: 6, border: "1px solid #58a6ff",
              background: "#58a6ff22", color: "#58a6ff", cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600,
            }}
          >Submit</button>
        </div>
      </form>
    </div>
  );
}

// ── Main SSH Terminal component ──────────────────────────────
export function SshTerminal({ hostId, cmd, title, fix, onClose, onAuthRequired }) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const [error, setError] = useState(null);
  const [passwordPrompt, setPasswordPrompt] = useState(false);

  useEffect(() => {
    let disposed = false;
    let term, fit, ws, ro;

    async function init() {
      // Fetch a short-lived WebSocket token (requires session cookie)
      let token;
      try {
        const resp = await fetch("/api/ssh-token");
        if (resp.status === 401) {
          if (!disposed) {
            setError("auth");
            onAuthRequired?.();
          }
          return;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        token = data.token;
      } catch (err) {
        if (!disposed) setError(err.message || "Failed to get auth token");
        return;
      }

      if (disposed) return;

      // Wait for fonts to be ready before xterm measures cell metrics
      const NERD_FONT = "'JetBrainsMono Nerd Font Mono'";
      try {
        await Promise.all([
          document.fonts.load(`13px ${NERD_FONT}`),
          document.fonts.load(`13px 'Noto Sans Mono CJK SC'`),
        ]);
      } catch {}

      if (disposed) return;

      term = new Terminal({
        theme: {
          background: "#0d1117",
          foreground: "#e6edf3",
          cursor: "#58a6ff",
          selectionBackground: "#264f78",
          black: "#0d1117", brightBlack: "#6e7681",
          red: "#ff7b72",   brightRed: "#ffa198",
          green: "#3fb950", brightGreen: "#56d364",
          yellow: "#d29922", brightYellow: "#e3b341",
          blue: "#58a6ff",  brightBlue: "#79c0ff",
          magenta: "#bc8cff", brightMagenta: "#d2a8ff",
          cyan: "#39c5cf",  brightCyan: "#56d4dd",
          white: "#b1bac4", brightWhite: "#f0f6fc",
        },
        fontFamily: "'JetBrainsMono Nerd Font Mono', 'Noto Sans Mono CJK SC', 'JetBrains Mono', monospace",
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
      });
      fit = new FitAddon();
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.loadAddon(fit);
      term.unicode.activeVersion = "11";
      term.open(containerRef.current);
      fit.fit();

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams();
      if (cmd) params.set("cmd", cmd);
      if (fix) params.set("fix", "1");
      if (token) params.set("token", token);
      const qs = params.toString();
      const url = `${proto}//${location.host}/ws/ssh/${encodeURIComponent(hostId)}${qs ? "?" + qs : ""}`;
      ws = new WebSocket(url);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          // Binary frame → raw terminal bytes
          term.write(new Uint8Array(e.data));
        } else {
          // Text frame → JSON control message
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === "password-prompt") {
              if (!disposed) setPasswordPrompt(true);
            }
          } catch {
            // Fallback: write raw text (shouldn't happen in normal flow)
            term.write(e.data);
          }
        }
      };

      ws.onerror = () => {
        if (!disposed) term.writeln("\r\n\x1b[31mWebSocket error\x1b[0m");
      };
      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4401 || e.code === 1008) {
          setError("auth");
          onAuthRequired?.();
        } else {
          term.writeln(`\r\n\x1b[33mDisconnected (${e.code})\x1b[0m`);
        }
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });

      ro = new ResizeObserver(() => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
      ro.observe(containerRef.current);
    }

    init();

    return () => {
      disposed = true;
      ro?.disconnect();
      ws?.close();
      term?.dispose();
      wsRef.current = null;
    };
  }, [hostId, cmd, fix]);

  const handlePasswordSubmit = (value) => {
    setPasswordPrompt(false);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "password-input", value }));
    }
  };

  const handlePasswordCancel = () => {
    setPasswordPrompt(false);
    onClose?.();
  };

  if (error === "auth") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", backgroundColor: "#161b22",
          borderBottom: "1px solid #30363d", flexShrink: 0,
        }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#58a6ff" }}>
            ⌨ {title || hostId}
          </span>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid #30363d", borderRadius: 4,
            color: "#8b949e", cursor: "pointer", padding: "2px 8px", fontSize: 12,
          }}>✕</button>
        </div>
        <div style={{
          flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 16, backgroundColor: "#0d1117",
        }}>
          <div style={{ fontSize: 32 }}>🔒</div>
          <div style={{ color: "#f87171", fontFamily: "monospace", fontSize: 13 }}>Session expired or not authenticated</div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px", borderRadius: 6, border: "1px solid #58a6ff",
              background: "none", color: "#58a6ff", cursor: "pointer", fontFamily: "monospace", fontSize: 13,
            }}
          >Log in again</button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", backgroundColor: "#161b22",
          borderBottom: "1px solid #30363d", flexShrink: 0,
        }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#58a6ff" }}>
            ⌨ {title || hostId}
          </span>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid #30363d", borderRadius: 4,
            color: "#8b949e", cursor: "pointer", padding: "2px 8px", fontSize: 12,
          }}>✕</button>
        </div>
        <div style={{
          flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 12, backgroundColor: "#0d1117",
        }}>
          <div style={{ color: "#f87171", fontFamily: "monospace", fontSize: 13 }}>Error: {error}</div>
          <button onClick={onClose} style={{
            padding: "6px 16px", borderRadius: 6, border: "1px solid #30363d",
            background: "none", color: "#8b949e", cursor: "pointer", fontFamily: "monospace", fontSize: 12,
          }}>Close</button>
        </div>
      </div>
    );
  }

  // Send a tmux key sequence (Ctrl+B prefix + key)
  const sendTmux = (key) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send("\x02" + key);
  };

  const tmuxBtns = [
    { label: "prev", title: "Prev window (C-b p)", key: "p" },
    { label: "next", title: "Next window (C-b n)", key: "n" },
    { label: "sess", title: "Sessions list (C-b s)", key: "s" },
    { label: "new",  title: "New window (C-b c)",  key: "c" },
    { label: "det",  title: "Detach (C-b d)",      key: "d" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {/* Title bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 12px", backgroundColor: "#161b22",
        borderBottom: "1px solid #30363d", flexShrink: 0, gap: 8,
      }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#58a6ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          ⌨ {title || hostId}
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "1px solid #30363d", borderRadius: 4,
          color: "#8b949e", cursor: "pointer", padding: "2px 8px", fontSize: 12, flexShrink: 0,
        }}>✕</button>
      </div>
      {/* Tmux control bar */}
      <div style={{
        display: "flex", gap: 4, padding: "4px 8px",
        backgroundColor: "#0d1117", borderBottom: "1px solid #30363d", flexShrink: 0,
      }}>
        {tmuxBtns.map(({ label, title: t, key }) => (
          <button key={key} onClick={() => sendTmux(key)} title={t} style={{
            padding: "2px 8px", borderRadius: 4, border: "1px solid #30363d",
            background: "none", color: "#8b949e", cursor: "pointer",
            fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
          }}>{label}</button>
        ))}
      </div>
      {/* Terminal fills remaining height */}
      <div ref={containerRef} style={{ flex: 1, overflow: "hidden", padding: 4 }} />
      {/* Password modal overlay */}
      {passwordPrompt && (
        <PasswordModal
          prompt={`SSH Password — ${title || hostId}`}
          onSubmit={handlePasswordSubmit}
          onCancel={handlePasswordCancel}
        />
      )}
    </div>
  );
}
