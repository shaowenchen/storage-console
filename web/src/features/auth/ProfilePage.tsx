import { useAuth } from './AuthProvider';
import { ApiKeysPanel } from './ApiKeysPanel';
import { useTheme } from '../../app/theme';
import './auth.css';

export function ProfilePage() {
  const { user, logout } = useAuth();
  const { preference, cyclePreference } = useTheme();

  return (
    <div className="page-profile">
      <h1 className="page-heading">Profile</h1>
      <p className="profile-subtitle">Account settings, API keys, and preferences.</p>

      <section className="profile-section">
        <h2 className="profile-section-title">Account</h2>
        <div className="profile-card">
          <div className="profile-field">
            <span className="profile-field-label">User</span>
            <span className="profile-field-value">{user}</span>
          </div>
        </div>
      </section>

      <section className="profile-section">
        <h2 className="profile-section-title">API Keys</h2>
        <p className="profile-section-help">
          Use these keys with <code>X-API-Key</code> for script uploads and downloads. The login key
          cannot call these APIs.
        </p>
        <ApiKeysPanel />
      </section>

      <section className="profile-section">
        <h2 className="profile-section-title">Preferences</h2>
        <div className="profile-card profile-actions">
          <button type="button" className="ghost-btn" onClick={cyclePreference}>
            Theme: {preference}
          </button>
          <button type="button" className="ghost-btn" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
