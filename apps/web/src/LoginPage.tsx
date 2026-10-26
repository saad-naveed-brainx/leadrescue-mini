import type { DevIdentityDto, MeDto } from '@lr/shared';
import { useEffect, useState } from 'react';
import { apiFetch, setToken } from './api';

// The dev login: pick any seeded person and the business to sign in to. Local demo only; the API
// refuses to start in production, where a real login would replace this screen.
export function LoginPage({ onSignedIn }: { onSignedIn: (me: MeDto) => void }) {
  const [identities, setIdentities] = useState<DevIdentityDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ identities: DevIdentityDto[] }>('/auth/dev-identities')
      .then((data) => setIdentities(data.identities))
      .catch((err: Error) => setError(err.message));
  }, []);

  async function signIn(userId: string, orgId: string) {
    setError(null);
    try {
      const { token } = await apiFetch<{ token: string }>('/auth/dev-login', {
        method: 'POST',
        body: { userId, orgId },
      });
      setToken(token);
      onSignedIn(await apiFetch<MeDto>('/me'));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="page">
      <h1>Sign in</h1>
      <p className="muted">Local demo login: choose who you are and which business to open.</p>
      {error && <p className="error">{error}</p>}
      <ul className="identity-list">
        {identities.flatMap((person) =>
          person.memberships.map((m) => (
            <li key={person.userId + m.orgId}>
              <button onClick={() => signIn(person.userId, m.orgId)}>
                <strong>{person.name}</strong>
                <span className="muted">
                  {m.orgName} · {m.role}
                </span>
              </button>
            </li>
          )),
        )}
      </ul>
    </main>
  );
}
