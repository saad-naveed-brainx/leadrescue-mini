import { useEffect, useRef, useState } from 'react';
import { type Conversation, apiFetch } from './api';

// One conversation, shown as a chat panel on the right: its messages, and the switch between AI (the AI answers) and MANUAL
// (a person has taken over, the AI stays quiet). `reloadKey` changes when a simulated SMS
// arrives, so the messages are fetched again.
export function ConversationPanel({
  user,
  conversationId,
  title,
  subtitle,
  reloadKey,
  onClose,
}: {
  user: string;
  conversationId: string;
  title: string;
  subtitle: string;
  reloadKey: number;
  onClose: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const load = () =>
      apiFetch<Conversation>(user, `/conversations/${conversationId}`)
        .then((data) => {
          setConversation(data);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    void load();
    // AI replies are sent by the background worker a moment after a text arrives, so check for
    // new messages every 2 seconds while the panel is open.
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [user, conversationId, reloadKey]);

  async function switchMode(mode: 'AI' | 'MANUAL') {
    setSwitching(true);
    setError(null);
    try {
      await apiFetch(user, `/conversations/${conversationId}/handoff`, {
        method: 'POST',
        body: { mode },
      });
      // Fetch again so the screen shows the saved mode.
      setConversation(await apiFetch<Conversation>(user, `/conversations/${conversationId}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  // Start at the newest message, like a chat app, whenever messages load or change.
  const messagesEnd = useRef<HTMLDivElement>(null);
  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: 'end' });
  }, [messageCount]);

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const manual = conversation?.mode === 'MANUAL';

  return (
    <>
      {/* Clicking the dimmed page behind the panel closes it. */}
      <div className="backdrop" onClick={onClose} />
      <aside className="chat" aria-label={`Conversation with ${title}`}>
        <header className="chat-head">
          <div className="avatar">{initials(title)}</div>
          <div className="chat-who">
            <strong>{title}</strong>
            <span className="muted">{subtitle}</span>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {conversation && (
          <div className={`chat-mode ${manual ? 'chat-mode-manual' : 'chat-mode-ai'}`}>
            <div>
              <strong>{manual ? 'MANUAL' : 'AI mode'}</strong>
              <span>
                {manual
                  ? 'A person has taken over. The AI stays quiet.'
                  : 'The AI answers new messages.'}
              </span>
            </div>
            <button
              className="primary"
              disabled={switching}
              onClick={() => void switchMode(manual ? 'AI' : 'MANUAL')}
            >
              {manual ? 'Hand back to AI' : 'Take over'}
            </button>
          </div>
        )}
        {error && <p className="error chat-error">{error}</p>}

        <div className="chat-body">
          {conversation?.messages.length === 0 && <p className="muted">No messages yet.</p>}
          {conversation?.messages.map((m) => (
            <div key={m.id} className={`bubble-row bubble-row-${m.author}`}>
              <div className={`bubble bubble-${m.author}`}>{m.body}</div>
              <span className="bubble-meta">
                {m.author === 'ai' ? 'AI' : 'Customer'} ·{' '}
                {new Date(m.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          ))}
          <div ref={messagesEnd} />
        </div>

        <footer className="chat-foot muted">
          Customer texts arrive through the webhook (use “Simulate an incoming SMS”).
        </footer>
      </aside>
    </>
  );
}

/** "Maria Lopez" → "ML"; a phone number → "#". */
function initials(name: string): string {
  if (name.startsWith('+')) return '#';
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
