import { useState, useEffect } from "react";

export function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(`ccm:${key}`);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(`ccm:${key}`, JSON.stringify(value));
    } catch { /* ignore quota errors */ }
  }, [key, value]);

  return [value, setValue];
}
