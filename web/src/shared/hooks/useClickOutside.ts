import { useEffect, useEffectEvent, type RefObject } from 'react';

type ElementRef = RefObject<HTMLElement | null>;

function isInsideAny(refs: ElementRef[], target: Node): boolean {
  return refs.some((ref) => ref.current?.contains(target));
}

export function useClickOutside(
  ref: ElementRef | ElementRef[],
  active: boolean,
  onOutside: () => void,
) {
  const onOutsideEvent = useEffectEvent(onOutside);
  const refs = Array.isArray(ref) ? ref : [ref];

  useEffect(() => {
    if (!active) return;

    const onPointerDown = (event: PointerEvent) => {
      if (isInsideAny(refs, event.target as Node)) return;
      onOutsideEvent();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOutsideEvent();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // Ref objects are stable; only rebind when the menu becomes active/inactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs intentionally omitted
  }, [active]);
}
