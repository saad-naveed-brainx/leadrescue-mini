import { useState } from 'react';
import { DEMO_USERS } from './api';
import { LeadsPage } from './LeadsPage';

// The top of the app: pick which seeded user you are (the mock login), then see that user's
// company's leads. Switching user shows the other company's data, nothing else changes.
export function App() {
  const [user, setUser] = useState(DEMO_USERS[0]!.email);

  return (
    <div>
      <header className="topbar">
        <strong className="brand">
          <span className="brand-mark">LR</span> LeadRescue Mini
        </strong>
        <label>
          Signed in as{' '}
          <select value={user} onChange={(e) => setUser(e.target.value)}>
            {DEMO_USERS.map((u) => (
              <option key={u.email} value={u.email}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <main className="page">
        {/* key={user}: a new user gets a fresh page, so nothing from the other company lingers. */}
        <LeadsPage key={user} user={user} />
      </main>
    </div>
  );
}
