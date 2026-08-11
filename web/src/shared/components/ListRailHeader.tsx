import { useRef, type ReactNode } from 'react';
import './list-rail.css';
import { useClickOutside } from '../hooks/useClickOutside';

type ListRailHeaderProps = {
  title: string;
  collapsedLabel: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  menuLabel?: string;
  menuChildren?: ReactNode;
  headerClassName?: string;
  titleClassName?: string;
  toggleClassName?: string;
  toggleTitle?: string;
};

export function ListRailHeader({
  title,
  collapsedLabel,
  collapsed,
  onToggleCollapsed,
  menuOpen,
  onMenuOpenChange,
  menuLabel = 'Actions',
  menuChildren,
  headerClassName = 'list-rail-header',
  titleClassName = 'list-rail-title',
  toggleClassName = 'list-rail-toggle',
  toggleTitle,
}: ListRailHeaderProps) {
  const actionsRef = useRef<HTMLDivElement>(null);
  useClickOutside(actionsRef, menuOpen, () => onMenuOpenChange(false));

  return (
    <div className={headerClassName}>
      <div className={titleClassName}>{title}</div>
      <div className="collapsed-list-label" title={title}>
        {collapsedLabel}
      </div>
      <div className="rail-header-actions" ref={actionsRef} onClick={(e) => e.stopPropagation()}>
        {menuChildren ? (
          <>
            <button
              type="button"
              className="rail-menu-btn"
              aria-label={menuLabel}
              aria-expanded={menuOpen}
              onClick={() => onMenuOpenChange(!menuOpen)}
            >
              ...
            </button>
            {menuOpen ? <div className="rail-action-menu show">{menuChildren}</div> : null}
          </>
        ) : null}
        <button
          type="button"
          className={toggleClassName}
          aria-label={toggleTitle ?? (collapsed ? 'Expand list' : 'Collapse list')}
          onClick={onToggleCollapsed}
        >
          ‹
        </button>
      </div>
    </div>
  );
}
