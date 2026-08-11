import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import './shell.css';

export function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
