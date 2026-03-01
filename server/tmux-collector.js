import { spawn } from "child_process";

/**
 * Python script that collects tmux status.
 * Tries libtmux first, falls back to parsing tmux CLI output.
 */
const TMUX_SCRIPT = `
import json, subprocess, sys, os, time

def collect_via_libtmux():
    """Collect tmux data using libtmux library."""
    import libtmux
    server = libtmux.Server()
    result = []
    for sess in server.sessions:
        windows = []
        for win in sess.windows:
            panes = []
            for pane in win.panes:
                panes.append({
                    "paneId": pane.pane_id,
                    "active": pane == win.active_pane,
                    "command": pane.pane_current_command,
                    "cwd": pane.pane_current_path,
                    "width": int(pane.pane_width),
                    "height": int(pane.pane_height),
                    "pid": int(pane.pane_pid),
                })
            windows.append({
                "windowId": win.window_id,
                "name": win.window_name,
                "active": win == sess.active_window,
                "layout": win.window_layout,
                "paneCount": len(win.panes),
                "panes": panes,
            })
        result.append({
            "sessionId": sess.session_id,
            "name": sess.session_name,
            "attached": sess.session_attached != "0",
            "windows": windows,
            "windowCount": len(sess.windows),
            "created": int(sess.session_created),
        })
    return result

def collect_via_cli():
    """Fallback: collect tmux data by parsing CLI output."""
    result = []

    # List sessions
    try:
        out = subprocess.check_output(
            ["tmux", "list-sessions", "-F",
             "#{session_id}|#{session_name}|#{session_attached}|#{session_windows}|#{session_created}"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []

    if not out:
        return []

    for sline in out.split("\\n"):
        parts = sline.split("|")
        if len(parts) < 5:
            continue
        sid, sname, attached, wcount, created = parts[0], parts[1], parts[2], parts[3], parts[4]

        # List windows for this session
        windows = []
        try:
            wout = subprocess.check_output(
                ["tmux", "list-windows", "-t", sname, "-F",
                 "#{window_id}|#{window_name}|#{window_active}|#{window_layout}|#{window_panes}"],
                text=True, stderr=subprocess.DEVNULL
            ).strip()
        except:
            wout = ""

        for wline in (wout.split("\\n") if wout else []):
            wp = wline.split("|")
            if len(wp) < 5:
                continue
            wid, wname, wactive, wlayout, wpcount = wp[0], wp[1], wp[2], wp[3], wp[4]

            # List panes for this window
            panes = []
            try:
                pout = subprocess.check_output(
                    ["tmux", "list-panes", "-t", f"{sname}:{wid}", "-F",
                     "#{pane_id}|#{pane_active}|#{pane_current_command}|#{pane_current_path}|#{pane_width}|#{pane_height}|#{pane_pid}"],
                    text=True, stderr=subprocess.DEVNULL
                ).strip()
            except:
                pout = ""

            for pline in (pout.split("\\n") if pout else []):
                pp = pline.split("|")
                if len(pp) < 7:
                    continue
                panes.append({
                    "paneId": pp[0],
                    "active": pp[1] == "1",
                    "command": pp[2],
                    "cwd": pp[3],
                    "width": int(pp[4]) if pp[4].isdigit() else 0,
                    "height": int(pp[5]) if pp[5].isdigit() else 0,
                    "pid": int(pp[6]) if pp[6].isdigit() else 0,
                })

            windows.append({
                "windowId": wid,
                "name": wname,
                "active": wactive == "1",
                "layout": wlayout,
                "paneCount": int(wpcount) if wpcount.isdigit() else len(panes),
                "panes": panes,
            })

        result.append({
            "sessionId": sid,
            "name": sname,
            "attached": attached != "0",
            "windows": windows,
            "windowCount": int(wcount) if wcount.isdigit() else len(windows),
            "created": int(created) if created.isdigit() else 0,
        })

    return result

# Try libtmux first, fall back to CLI
try:
    sessions = collect_via_libtmux()
    method = "libtmux"
except ImportError:
    sessions = collect_via_cli()
    method = "cli"
except Exception as e:
    sessions = collect_via_cli()
    method = "cli-fallback"

print(json.dumps({"sessions": sessions, "method": method}))
`;

/**
 * Collect tmux status from the local machine.
 */
export async function collectTmuxLocal(hostName = "local") {
  return new Promise((resolve) => {
    const proc = spawn("python3", ["-c", TMUX_SCRIPT], {
      timeout: 10_000,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({
        host: hostName,
        status: "error",
        error: "tmux collection timed out after 10s",
        sessions: [],
        collectedAt: Date.now(),
      });
    }, 10_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        // tmux not running or not installed is not an error — just empty
        resolve({
          host: hostName,
          status: "ok",
          sessions: [],
          method: null,
          collectedAt: Date.now(),
        });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({
          host: hostName,
          status: "ok",
          ...data,
          collectedAt: Date.now(),
        });
      } catch (err) {
        resolve({
          host: hostName,
          status: "error",
          error: `JSON parse error: ${err.message}`,
          sessions: [],
          collectedAt: Date.now(),
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        host: hostName,
        status: "error",
        error: err.message,
        sessions: [],
        collectedAt: Date.now(),
      });
    });
  });
}

/**
 * Collect tmux status from a remote host via SSH.
 */
export async function collectTmuxSSH(hostConfig) {
  const { sshAlias, user, host, port = 22, identityFile } = hostConfig;

  const sshArgs = [
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
  ];

  if (sshAlias) {
    sshArgs.push(sshAlias);
  } else {
    sshArgs.push("-o", "StrictHostKeyChecking=accept-new");
    if (port !== 22) sshArgs.push("-p", String(port));
    if (identityFile) sshArgs.push("-i", identityFile);
    sshArgs.push(`${user}@${host}`);
  }

  sshArgs.push("python3", "-");

  return new Promise((resolve) => {
    const proc = spawn("ssh", sshArgs, { timeout: 15_000 });

    let stdout = "";
    let stderr = "";

    proc.stdin.write(TMUX_SCRIPT);
    proc.stdin.end();

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({
        host: hostConfig.name,
        status: "error",
        error: "SSH tmux collection timed out after 15s",
        sessions: [],
        collectedAt: Date.now(),
      });
    }, 15_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        resolve({
          host: hostConfig.name,
          status: "ok",
          sessions: [],
          method: null,
          collectedAt: Date.now(),
        });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({
          host: hostConfig.name,
          status: "ok",
          ...data,
          collectedAt: Date.now(),
        });
      } catch (err) {
        resolve({
          host: hostConfig.name,
          status: "error",
          error: `JSON parse error: ${err.message}`,
          sessions: [],
          collectedAt: Date.now(),
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        host: hostConfig.name,
        status: "error",
        error: err.message,
        sessions: [],
        collectedAt: Date.now(),
      });
    });
  });
}
