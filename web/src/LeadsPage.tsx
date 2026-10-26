import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type Lead, LEAD_STATUSES, apiFetch } from './api';

// The current company's leads, newest first, and a form to add one.
export function LeadsPage({ user }: { user: string }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadLeads = useCallback(async () => {
    try {
      const data = await apiFetch<{ leads: Lead[] }>(user, '/leads');
      setLeads(data.leads);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [user]);

  useEffect(() => {
    void loadLeads();
  }, [loadLeads]);

  return (
    <>
      <h1>Leads</h1>
      <CreateLeadForm user={user} onCreated={loadLeads} />
      {error && <p className="error">{error}</p>}
      {leads.length === 0 ? (
        <p className="muted">No leads yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                {/* A lead created by an incoming SMS has no name yet. */}
                <td>{lead.name ?? <span className="muted">(from SMS)</span>}</td>
                <td>{lead.phone}</td>
                <td>
                  <span className={`status status-${lead.status}`}>{lead.status}</span>
                </td>
                <td className="muted">{lead.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function CreateLeadForm({ user, onCreated }: { user: string; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<Lead['status']>('new');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(user, '/leads', {
        method: 'POST',
        // Empty notes are left out rather than sent as "".
        body: { name, phone, status, ...(notes.trim() && { notes }) },
      });
      setName('');
      setPhone('');
      setStatus('new');
      setNotes('');
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card create-form" onSubmit={submit}>
      <h2>Add a lead</h2>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        placeholder="Phone, e.g. +16465550150"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <select value={status} onChange={(e) => setStatus(e.target.value as Lead['status'])}>
        {LEAD_STATUSES.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <input
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button type="submit">Add lead</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
