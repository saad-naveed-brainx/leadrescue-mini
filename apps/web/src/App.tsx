import type { MeDto } from '@lr/shared';
import { useEffect, useState } from 'react';
import { ApiError, apiFetch, clearToken, getToken } from './api';
import { LoginPage } from './LoginPage';

// The top of the app: shows the login screen until someone is signed in, then the signed-in view.
export function App() {
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(getToken() !== null);

  // After a page refresh we may still hold a token: ask the API who it belongs to.
  useEffect(() => {
    if (getToken() === null) return;
    apiFetch<MeDto>('/me')
      .then(setMe)
      .catch((err) => {
        // An expired or refused token: forget it and show the login screen.
        if (err instanceof ApiError && err.status === 401) clearToken();
      })
      .finally(() => setLoading(false));
  }, []);

  function signOut() {
    clearToken();
    setMe(null);
  }

  if (loading) return <p className="page">Loading…</p>;
  if (!me) return <LoginPage onSignedIn={setMe} />;

  return (
    <div>
      <header className="topbar">
        <strong>LeadRescue Mini</strong>
        <span>
          {me.user.name} · {me.org.name} · {me.role}
        </span>
        <button onClick={signOut}>Sign out</button>
      </header>
      <main className="page">
        <p>Signed in. The lead list comes next.</p>
      </main>
    </div>
  );
}
