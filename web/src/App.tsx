import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthProvider';
import { AppRouter } from './app/router';
import { ThemeProvider } from './app/theme';
import { AppNoticeProvider } from './shared/components/AppNotice';
import { getRoutePrefix } from './shared/config';

export function App() {
  const basename = getRoutePrefix() || '/';
  return (
    <ThemeProvider>
      <AppNoticeProvider>
        <AuthProvider>
          <BrowserRouter basename={basename}>
            <AppRouter />
          </BrowserRouter>
        </AuthProvider>
      </AppNoticeProvider>
    </ThemeProvider>
  );
}
