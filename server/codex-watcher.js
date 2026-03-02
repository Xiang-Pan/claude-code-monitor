import chokidar from "chokidar";
import path from "path";
import { scanCodexDir } from "./codex-parser.js";

/**
 * Watch a local ~/.codex directory for changes and emit session updates.
 */
export function createCodexWatcher(codexDir, hostName, onChange) {
  const sessionsDir = path.join(codexDir, "sessions");

  let debounceTimer = null;

  const handleChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const sessions = await scanCodexDir(codexDir);
        onChange({
          host: hostName,
          status: "connected",
          sessions,
          statsCache: null,
          collectedAt: Date.now(),
        });
      } catch (err) {
        console.error(`[codex-watcher] Error scanning ${codexDir}:`, err.message);
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

  const watcher = chokidar.watch(
    [path.join(sessionsDir, "**", "*.jsonl")],
    {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
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
      console.error(`[codex-watcher] Chokidar error on ${codexDir}:`, err.message);
    });

  // Initial scan
  handleChange();

  const rescan = async () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    try {
      const sessions = await scanCodexDir(codexDir);
      onChange({
        host: hostName,
        status: "connected",
        sessions,
        statsCache: null,
        collectedAt: Date.now(),
      });
    } catch (err) {
      console.error(`[codex-watcher] Error scanning ${codexDir}:`, err.message);
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
