import { useCallback, useState } from 'react';

function readCollapsed(storageKey: string, legacyKey?: string): boolean {
  try {
    const current = localStorage.getItem(storageKey);
    if (current === '1' || current === '0') return current === '1';
    if (legacyKey) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy === '1' || legacy === '0') {
        localStorage.setItem(storageKey, legacy);
        localStorage.removeItem(legacyKey);
        return legacy === '1';
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function useRailCollapsed(storageKey: string, legacyKey?: string) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey, legacyKey));

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
        if (legacyKey) localStorage.removeItem(legacyKey);
      } catch {
        // ignore
      }
      return next;
    });
  }, [legacyKey, storageKey]);

  return { collapsed, setCollapsed, toggleCollapsed };
}
