import { spawn } from "child_process";

/**
 * Execute a command and return { ok, message } or { ok: false, error }.
 * Resolves when the command exits (for kill) or shortly after spawn (for tmux).
 */
function exec(command, args, { timeout = 15000, waitForExit = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    if (!waitForExit) {
      // For tmux spawns, resolve quickly after launch
      setTimeout(() => resolve({ ok: true, message: "Launched" }), 500);
      return;
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, message: stdout.trim() || "Done" });
      } else {
        resolve({ ok: false, error: stderr.trim() || `Exit code ${code}` });
      }
    });

    child.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * Build SSH args from host config, similar to ssh-collector.js
 */
function sshTarget(hostConfig) {
  const args = ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes"];
  if (hostConfig._controlPath) {
    args.push("-o", `ControlPath=${hostConfig._controlPath}`);
  }
  if (hostConfig.sshAlias) {
    args.push(hostConfig.sshAlias);
  } else {
    args.push("-o", "StrictHostKeyChecking=accept-new");
    if (hostConfig.port && hostConfig.port !== 22) args.push("-p", String(hostConfig.port));
    if (hostConfig.identityFile) args.push("-i", hostConfig.identityFile);
    args.push(`${hostConfig.user}@${hostConfig.host}`);
  }
  return args;
}

/**
 * Resume a session — opens in a new tmux window.
 */
export async function resume(sessionId, hostConfig) {
  const claudeCmd = `claude --resume ${sessionId}`;

  if (!hostConfig || hostConfig.mode === "local") {
    // Local: spawn in a new tmux window
    return exec("tmux", ["new-window", "-n", `claude-${sessionId.slice(0, 8)}`, claudeCmd], { waitForExit: false });
  }

  // Remote via SSH
  const sshArgs = sshTarget(hostConfig);
  const remoteCmd = `tmux new-window -n 'claude-${sessionId.slice(0, 8)}' '${claudeCmd}'`;
  sshArgs.push(remoteCmd);
  return exec("ssh", sshArgs);
}

/**
 * Fork a session — new session inherits conversation history.
 */
export async function fork(sessionId, hostConfig) {
  const claudeCmd = `claude --resume ${sessionId} --fork-session`;

  if (!hostConfig || hostConfig.mode === "local") {
    return exec("tmux", ["new-window", "-n", `fork-${sessionId.slice(0, 8)}`, claudeCmd], { waitForExit: false });
  }

  const sshArgs = sshTarget(hostConfig);
  const remoteCmd = `tmux new-window -n 'fork-${sessionId.slice(0, 8)}' '${claudeCmd}'`;
  sshArgs.push(remoteCmd);
  return exec("ssh", sshArgs);
}

/**
 * Close/kill a session — find and SIGTERM the Claude process for this session.
 */
export async function close(sessionId, hostConfig) {
  if (!hostConfig || hostConfig.mode === "local") {
    // Local: find PID and kill
    const pgrepResult = await exec("pgrep", ["-f", sessionId]);
    if (!pgrepResult.ok || !pgrepResult.message.trim()) {
      return { ok: false, error: "Process not found" };
    }
    const pids = pgrepResult.message.trim().split("\n").filter(Boolean);
    if (pids.length === 0) {
      return { ok: false, error: "Process not found" };
    }
    return exec("kill", pids);
  }

  // Remote via SSH
  const sshArgs = sshTarget(hostConfig);
  const remoteCmd = `pgrep -f '${sessionId}' | xargs -r kill`;
  sshArgs.push(remoteCmd);
  const result = await exec("ssh", sshArgs);
  // pgrep returns exit 1 when no processes match
  if (!result.ok && result.error === "Exit code 1") {
    return { ok: false, error: "Process not found" };
  }
  return result.ok ? { ok: true, message: "Session terminated" } : result;
}
