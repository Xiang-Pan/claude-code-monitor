import chokidar from "chokidar";
import path from "path";
import { scanClaudeDir, parseStatsCache } from "./parser.js";

/**
 * Watch a local ~/.claude directory for changes and emit session updates.
 */
export function createWatcher(claudeDir, hostName, onChange) {
  const projectsDir = path.join(claudeDir, "projects");
  const statsPath = path.join(claudeDir, "stats-cache.json");

  let debounceTimer = null;

  const handleChange = () => {
    // Debounce rapid changes (Claude writes frequently during active sessions)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const sessions = await scanClaudeDir(claudeDir);
        const stats = await parseStatsCache(claudeDir);
        onChange({
          host: hostName,
          status: "connected",
          sessions,
          statsCache: stats,
          collectedAt: Date.now(),
        });
      } catch (err) {
        console.error(`[watcher] Error scanning ${claudeDir}:`, err.message);
        onChange({
          host: hostName,
          status: "error",
          error: err.message,
          sessions: [],
          statsCache: null,
          collectedAt: Date.now(),
        });
      }
    }, 500);
  };

  // Watch projects dir and stats file for changes.
  // Note: chokidar glob patterns (e.g. **/*.jsonl) are unreliable on some
  // platforms, so we watch the directories directly and filter in the callback.
  const watcher = chokidar.watch(
    [projectsDir, statsPath],
    {
      persistent: true,
      ignoreInitial: false,
      depth: 2,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
      ignored: (filePath, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        // Only react to relevant file types
        if (!filePath.endsWith(".jsonl") && !filePath.endsWith(".json")) return true;
        // Skip files not modified in the last 24h
        return Date.now() - stats.mtimeMs > 86_400_000;
      },
    }
  );

  watcher
    .on("add", handleChange)
    .on("change", handleChange)
    .on("unlink", handleChange)
    .on("error", (err) => {
      console.error(`[watcher] Chokidar error on ${claudeDir}:`, err.message);
    });

  // Initial scan
  handleChange();

  // Immediate scan (bypasses debounce) for manual refresh
  const rescan = async () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    try {
      const sessions = await scanClaudeDir(claudeDir);
      const stats = await parseStatsCache(claudeDir);
      onChange({
        host: hostName,
        status: "connected",
        sessions,
        statsCache: stats,
        collectedAt: Date.now(),
      });
    } catch (err) {
      console.error(`[watcher] Error scanning ${claudeDir}:`, err.message);
      onChange({
        host: hostName,
        status: "error",
        error: err.message,
        sessions: [],
        statsCache: null,
        collectedAt: Date.now(),
      });
    }
  };

  return {
    rescan,
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    },
  };
}
