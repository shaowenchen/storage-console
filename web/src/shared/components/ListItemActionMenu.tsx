import { useRef, type ReactNode } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';

type Props = {
  menuId: string;
  openMenuId: string | null;
  onOpenMenuChange: (menuId: string | null) => void;
  menuClassName: string;
  buttonLabel: string;
  header: ReactNode;
  children: ReactNode;
};

export function ListItemActionMenu({
  menuId,
  openMenuId,
  onOpenMenuChange,
  menuClassName,
  buttonLabel,
  header,
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const open = openMenuId === menuId;

  useClickOutside(rootRef, open, () => onOpenMenuChange(null));

  return (
    <div className="list-item-action-menu" ref={rootRef}>
      <div className="bucket-item-top">
        {header}
        <button
          type="button"
          className="bucket-menu-btn"
          aria-label={buttonLabel}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenuChange(open ? null : menuId);
          }}
        >
          ⋮
        </button>
      </div>
      {open ? (
        <div className={menuClassName} onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
