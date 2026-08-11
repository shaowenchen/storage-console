import { NavLink } from 'react-router-dom';
import { useAuth } from '../../features/auth/AuthProvider';
import { ApiKeysPanel } from '../../features/auth/ApiKeysPanel';
import { useTheme } from '../theme';

type NavItem = {
  to: string;
  label: string;
};

const NAV: NavItem[] = [{ to: '/', label: 'Storages' }];

function NavSection({ items }: { items: NavItem[] }) {
  return (
    <div className="nav-section">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const { preference, cyclePreference } = useTheme();

  return (
    <aside className="app-sidebar">
      <div className="app-brand">storage-console</div>
      <nav className="app-nav" aria-label="Primary">
        <NavSection items={NAV} />
      </nav>
      <div className="app-sidebar-footer">
        <div className="sidebar-user">{user}</div>
        <ApiKeysPanel />
        <button type="button" className="ghost-btn" onClick={cyclePreference}>
          Theme: {preference}
        </button>
        <button type="button" className="ghost-btn" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
