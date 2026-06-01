import { spawn, execFile } from "child_process";

const CONTROL_PATH = "/tmp/ccm-ssh-%C";
const HEALTH_CHECK_INTERVAL = 60_000;
const CHECK_POLL_MS = 500;
const CHECK_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Manages persistent SSH ControlMaster connections for all SSH-capable hosts.
 * Other modules add `-o ControlPath=/tmp/ccm-ssh-%C` to their ssh args
 * to transparently reuse these master connections.
 */
export class SSHPool {
  constructor() {
    this.connections = new Map(); // name -> { proc, status, alias, connectedAt, error, retries, timer }
    this.healthTimer = null;
    this.listeners = new Set();
    this.stopped = false;
  }

  /**
   * Returns the ControlPath pattern for other modules to use.
   */
  getControlPath() {
    return CONTROL_PATH;
  }

  /**
   * Start persistent connections for all SSH-capable hosts.
   */
  async start(hosts) {
    const sshHosts = hosts.filter((h) => h.ssh);
    if (sshHosts.length === 0) return;

    console.log(`[ssh-pool] Starting persistent connections for ${sshHosts.length} host(s)`);

    const results = await Promise.allSettled(
      sshHosts.map((h) => this._connect(h))
    );

    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        console.error(`[ssh-pool] Failed to connect ${sshHosts[i].name}:`, result.reason?.message);
      }
    }

    // Periodic health check
    this.healthTimer = setInterval(() => this._healthCheck(), HEALTH_CHECK_INTERVAL);
  }

  /**
   * Graceful shutdown — close all master connections.
   */
  async stop() {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);

    const jobs = [];
    for (const [name, conn] of this.connections) {
      if (conn.timer) clearTimeout(conn.timer);
      jobs.push(this._exit(conn.alias, name));
    }
    await Promise.allSettled(jobs);
    this.connections.clear();
    console.log("[ssh-pool] All connections closed");
  }

  /**
   * Get status of all connections.
   */
  getStatus() {
    const result = {};
    for (const [name, conn] of this.connections) {
      result[name] = {
        status: conn.status,
        alias: conn.alias,
        connectedAt: conn.connectedAt,
        error: conn.error,
      };
    }
    return result;
  }

  /**
   * Subscribe to status changes.
   */
  onStatusChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Internal ───────────────────────────────────────────────

  _notify() {
    const status = this.getStatus();
    for (const fn of this.listeners) {
      try { fn(status); } catch {}
    }
  }

  _setStatus(name, status, error = null) {
    const conn = this.connections.get(name);
    if (!conn) return;
    conn.status = status;
    conn.error = error;
    if (status === "connected") conn.connectedAt = Date.now();
    this._notify();
  }

  async _connect(hostConfig) {
    const name = hostConfig.name;
    const alias = hostConfig.ssh?.alias || hostConfig.name;

    // Initialize connection entry
    if (!this.connections.has(name)) {
      this.connections.set(name, {
        proc: null,
        status: "connecting",
        alias,
        connectedAt: null,
        error: null,
        retries: 0,
        timer: null,
      });
    }

    const conn = this.connections.get(name);
    conn.status = "connecting";
    conn.error = null;
    this._notify();

    // Check if an existing master is still alive (from a prior run)
    const existing = await this._check(alias);
    if (existing) {
      console.log(`[ssh-pool] ${name}: reusing existing master connection`);
      conn.status = "connected";
      conn.connectedAt = Date.now();
      conn.retries = 0;
      this._notify();
      return;
    }

    // Spawn new master
    console.log(`[ssh-pool] ${name}: establishing master connection to ${alias}`);
    const proc = spawn("ssh", [
      "-o", `ControlMaster=yes`,
      "-o", `ControlPath=${CONTROL_PATH}`,
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=30",
      "-N",
      alias,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    conn.proc = proc;

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      console.error(`[ssh-pool] ${name}: spawn error:`, err.message);
      this._setStatus(name, "disconnected", err.message);
      this._scheduleReconnect(hostConfig);
    });

    proc.on("exit", (code) => {
      if (this.stopped) return;
      const msg = stderr.trim() || `exited with code ${code}`;
      console.log(`[ssh-pool] ${name}: master exited (${msg})`);
      this._setStatus(name, "disconnected", msg);
      this._scheduleReconnect(hostConfig);
    });

    // Wait for master to be ready by polling ssh -O check
    const ready = await this._waitForReady(alias, CHECK_TIMEOUT_MS);
    if (ready) {
      console.log(`[ssh-pool] ${name}: connected`);
      conn.status = "connected";
      conn.connectedAt = Date.now();
      conn.retries = 0;
      this._notify();
    } else {
      console.error(`[ssh-pool] ${name}: timed out waiting for master`);
      conn.status = "disconnected";
      conn.error = "Connection timed out";
      try { proc.kill(); } catch {}
      this._notify();
      this._scheduleReconnect(hostConfig);
    }
  }

  _scheduleReconnect(hostConfig) {
    if (this.stopped) return;
    const conn = this.connections.get(hostConfig.name);
    if (!conn) return;
    if (conn.timer) clearTimeout(conn.timer);

    conn.retries++;
    const delay = Math.min(1000 * Math.pow(2, conn.retries - 1), MAX_BACKOFF_MS);
    const jitter = delay * (0.8 + Math.random() * 0.4);
    const waitMs = Math.round(jitter);

    console.log(`[ssh-pool] ${hostConfig.name}: reconnecting in ${(waitMs / 1000).toFixed(1)}s (attempt ${conn.retries})`);
    conn.status = "reconnecting";
    this._notify();

    conn.timer = setTimeout(() => {
      if (!this.stopped) this._connect(hostConfig);
    }, waitMs);
  }

  /**
   * Run `ssh -O check` to verify master is alive.
   */
  _check(alias) {
    return new Promise((resolve) => {
      execFile("ssh", [
        "-o", `ControlPath=${CONTROL_PATH}`,
        "-O", "check",
        alias,
      ], { timeout: 5_000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Run `ssh -O exit` to gracefully close master.
   */
  _exit(alias, name) {
    return new Promise((resolve) => {
      execFile("ssh", [
        "-o", `ControlPath=${CONTROL_PATH}`,
        "-O", "exit",
        alias,
      ], { timeout: 5_000 }, (err) => {
        if (err) console.log(`[ssh-pool] ${name}: exit signal failed (${err.message})`);
        resolve();
      });
    });
  }

  /**
   * Poll ssh -O check until master is ready or timeout.
   */
  async _waitForReady(alias, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this._check(alias);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
    }
    return false;
  }

  /**
   * Periodic health check for all connections.
   */
  async _healthCheck() {
    for (const [name, conn] of this.connections) {
      if (conn.status !== "connected") continue;
      const ok = await this._check(conn.alias);
      if (!ok) {
        console.log(`[ssh-pool] ${name}: health check failed, triggering reconnect`);
        if (conn.proc) try { conn.proc.kill(); } catch {}
        this._setStatus(name, "disconnected", "Health check failed");
        // Find the host config to reconnect
        // We store the alias, so we can reconstruct a minimal config
        this._scheduleReconnect({ name, ssh: { alias: conn.alias } });
      }
    }
  }
}
