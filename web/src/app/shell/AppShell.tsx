import { Outlet } from 'react-router-dom';
import './shell.css';

export function AppShell() {
  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
