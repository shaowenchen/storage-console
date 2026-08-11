import { NavLink } from 'react-router-dom';
import { useAuth } from '../../features/auth/AuthProvider';

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
};

const NAV: NavItem[] = [
  { to: '/', label: 'Storages', end: true },
  { to: '/profile', label: 'Profile' },
];

function NavSection({ items }: { items: NavItem[] }) {
  return (
    <div className="nav-section">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export function Sidebar() {
  const { user } = useAuth();

  return (
    <aside className="app-sidebar">
      <div className="app-brand">storage-console</div>
      <nav className="app-nav" aria-label="Primary">
        <NavSection items={NAV} />
      </nav>
      <div className="app-sidebar-footer">
        <NavLink to="/profile" className="sidebar-user-link">
          {user}
        </NavLink>
      </div>
    </aside>
  );
}
