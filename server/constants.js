/** Status-inference thresholds (shared between local parser and SSH collector). */
export const ACTIVE_THRESHOLD_MS = 60_000;   // < 1 min  → active
export const IDLE_THRESHOLD_MS = 600_000;    // < 10 min → idle
export const STUCK_THRESHOLD_MS = 300_000;   // 5 min without assistant output → stuck
