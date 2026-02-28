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

  // Watch for JSONL file changes in projects/
  const watcher = chokidar.watch(
    [
      path.join(projectsDir, "**", "*.jsonl"),
      path.join(projectsDir, "**", "sessions-index.json"),
      statsPath,
    ],
    {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
      // Only watch files modified in last 24h to avoid scanning old sessions
      ignored: (filePath, stats) => {
        if (!stats) return false;
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
