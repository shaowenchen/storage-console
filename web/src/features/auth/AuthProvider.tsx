import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '../../shared/api';
import { parseApiError } from '../../shared/apiError';

type AuthContextValue = {
  user: string | null;
  isAdmin: boolean;
  loading: boolean;
  login: (key: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const res = await apiFetch('/auth/session');
        if (!res.ok) {
          if (!cancelled) clearSession();
          return;
        }
        const data = (await res.json()) as { user?: string };
        if (!cancelled && data.user) setUser(data.user);
      } catch {
        // Transient network failure — stay logged out until retry on navigation.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const login = useCallback(async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('Login key is required');
    const res = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ key: trimmed }),
    });
    const data = (await res.json()) as { user?: string };
    if (!res.ok || !data.user) {
      throw new Error(parseApiError(data, 'Invalid login key'));
    }
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAdmin: user === 'admin',
      loading,
      login,
      logout,
    }),
    [user, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
