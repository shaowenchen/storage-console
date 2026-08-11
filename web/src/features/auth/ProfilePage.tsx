import { useAuth } from './AuthProvider';
import { ApiKeysPanel } from './ApiKeysPanel';
import { useTheme, type ThemePreference } from '../../app/theme';
import './profile.css';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function ProfilePage() {
  const { user, logout } = useAuth();
  const { preference, setPreference } = useTheme();

  return (
    <div className="page-profile">
      <h1 className="page-heading">Profile</h1>

      <div className="profile-layout">
        <div className="profile-summary">
          <div className="profile-summary-main">
            <div className="profile-summary-title">{user}</div>
            <div className="profile-summary-meta">Signed in with login key</div>
          </div>
          <div className="profile-summary-actions">
            <button
              type="button"
              className="ghost-btn profile-signout"
              onClick={() => void logout()}
            >
              Sign out
            </button>
          </div>
        </div>

        <section className="profile-section">
          <div className="profile-section-header">
            <h2>Account</h2>
          </div>
          <div className="profile-row">
            <div className="profile-label">Username</div>
            <div className="profile-value">{user}</div>
          </div>
        </section>

        <section className="profile-section">
          <div className="profile-section-header">
            <h2>API Keys</h2>
            <p className="profile-section-help">
              Use with <code>X-API-Key</code> for scripts. Login key cannot call these APIs.
            </p>
          </div>
          <ApiKeysPanel />
        </section>

        <section className="profile-section">
          <div className="profile-section-header">
            <h2>Appearance</h2>
          </div>
          <div className="theme-preference-options">
            {THEME_OPTIONS.map((opt) => (
              <label className="theme-preference-option" key={opt.value}>
                <input
                  type="radio"
                  name="theme-preference"
                  value={opt.value}
                  checked={preference === opt.value}
                  onChange={() => setPreference(opt.value)}
                />
                <span className="theme-preference-label">{opt.label}</span>
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
