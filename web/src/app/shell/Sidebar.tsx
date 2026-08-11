import { NavLink } from 'react-router-dom';
import { useAuth } from '../../features/auth/AuthProvider';

export function Sidebar() {
  const { user } = useAuth();

  return (
    <aside className="app-sidebar">
      <div className="app-brand">storage-console</div>
      <nav className="app-nav" aria-label="Primary">
        <div className="nav-section">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            Storages
          </NavLink>
        </div>
      </nav>
      <div className="app-sidebar-footer">
        <div className="sidebar-user">{user}</div>
        <NavLink
          to="/profile"
          className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
        >
          Profile
        </NavLink>
      </div>
    </aside>
  );
}
