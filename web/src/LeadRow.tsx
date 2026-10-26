import { type FormEvent, useState } from 'react';
import { type Lead, LEAD_STATUSES, apiFetch } from './api';

// One lead in the table. Status saves as soon as you pick it; notes save with the Save button.
// Both go through PATCH /leads/:id, and the row shows what the API sent back.
export function LeadRow({
  user,
  lead,
  onChanged,
}: {
  user: string;
  lead: Lead;
  onChanged: (lead: Lead) => void;
}) {
  const [notes, setNotes] = useState(lead.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(changes: { status?: Lead['status']; notes?: string | null }) {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<Lead>(user, `/leads/${lead.id}`, {
        method: 'PATCH',
        body: changes,
      });
      onChanged(updated);
      setNotes(updated.notes ?? '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function saveNotes(e: FormEvent) {
    e.preventDefault();
    // An empty box clears the notes (the API takes null for that).
    void save({ notes: notes.trim() === '' ? null : notes });
  }

  const notesChanged = notes !== (lead.notes ?? '');

  return (
    <tr>
      {/* A lead created by an incoming SMS has no name yet. */}
      <td>{lead.name ?? <span className="muted">(from SMS)</span>}</td>
      <td>{lead.phone}</td>
      <td>
        <select
          aria-label={`Status of ${lead.name ?? lead.phone}`}
          className={`status status-${lead.status}`}
          value={lead.status}
          disabled={saving}
          onChange={(e) => void save({ status: e.target.value as Lead['status'] })}
        >
          {LEAD_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </td>
      <td>
        <form className="notes-form" onSubmit={saveNotes}>
          <input
            aria-label={`Notes for ${lead.name ?? lead.phone}`}
            placeholder="Add notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {notesChanged && (
            <button type="submit" disabled={saving}>
              Save
            </button>
          )}
        </form>
        {error && <p className="error">{error}</p>}
      </td>
    </tr>
  );
}
