import { useEffect, useState } from 'react';

/**
 * Tracks a media query so a component can branch on the layout, not just on
 * the window width: `(max-width: 640px)` and `(pointer: coarse)` answer
 * different questions and a resize listener only answers the first.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    // Re-read on subscribe: the query can change without a resize event.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
