import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { DEMO_USERS, type Lead, LEAD_STATUSES, apiFetch } from './api';
import { ConversationPanel } from './ConversationPanel';
import { LeadRow } from './LeadRow';
import { type InboundResult, SimulateSmsPanel } from './SimulateSmsPanel';

// The current company's leads, newest first, a form to add one, the simulated-SMS panel, and
// the open conversation (if any).
export function LeadsPage({ user }: { user: string }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  // Bumped after a simulated SMS, so the open conversation fetches its messages again.
  const [reloadKey, setReloadKey] = useState(0);

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

  // After an edit, swap in the lead the API sent back, so the list shows what was saved.
  function replaceLead(updated: Lead) {
    setLeads((current) => current.map((l) => (l.id === updated.id ? updated : l)));
  }

  async function onSmsSent(toNumber: string, result: InboundResult) {
    await loadLeads(); // a new customer becomes a new lead
    setReloadKey((k) => k + 1);
    // Open the conversation only if the SMS went to this user's own company; another company's
    // conversation would (rightly) answer 404.
    const ownNumber = DEMO_USERS.find((u) => u.email === user)?.companyNumber;
    if (result.result === 'saved' && toNumber === ownNumber) {
      setOpenConversationId(result.conversationId);
    }
  }

  const openLead = leads.find((l) => l.conversationId === openConversationId);

  return (
    <>
      <div className="tools">
        <CreateLeadForm user={user} onCreated={loadLeads} />
        <SimulateSmsPanel onSent={(to, result) => void onSmsSent(to, result)} />
      </div>
      <h1>
        Leads <span className="count">{leads.length}</span>
      </h1>
      {error && <p className="error">{error}</p>}
      {leads.length === 0 ? (
        <p className="muted">No leads yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Conversation</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <LeadRow
                  key={lead.id}
                  user={user}
                  lead={lead}
                  onChanged={replaceLead}
                  onOpenConversation={setOpenConversationId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openConversationId && (
        <ConversationPanel
          key={openConversationId}
          user={user}
          conversationId={openConversationId}
          title={openLead ? (openLead.name ?? openLead.phone) : 'customer'}
          reloadKey={reloadKey}
          onClose={() => setOpenConversationId(null)}
        />
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
      <button className="primary" type="submit">
        Add lead
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
