import { useEffect, useState } from 'react';
import { type Conversation, apiFetch } from './api';

// One conversation: its messages, and the switch between AI (the AI answers) and MANUAL
// (a person has taken over, the AI stays quiet). `reloadKey` changes when a simulated SMS
// arrives, so the messages are fetched again.
export function ConversationPanel({
  user,
  conversationId,
  title,
  reloadKey,
  onClose,
}: {
  user: string;
  conversationId: string;
  title: string;
  reloadKey: number;
  onClose: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    apiFetch<Conversation>(user, `/conversations/${conversationId}`)
      .then((data) => {
        setConversation(data);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
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

  return (
    <section className="card conversation">
      <div className="conversation-head">
        <h2>Conversation with {title}</h2>
        <button onClick={onClose}>Close</button>
      </div>
      {error && <p className="error">{error}</p>}
      {conversation && (
        <>
          <div className="mode-row">
            <span className={`mode mode-${conversation.mode}`}>
              {conversation.mode === 'AI' ? 'AI is replying' : 'MANUAL: a person has taken over'}
            </span>
            {conversation.mode === 'AI' ? (
              <button disabled={switching} onClick={() => void switchMode('MANUAL')}>
                Take over (MANUAL)
              </button>
            ) : (
              <button disabled={switching} onClick={() => void switchMode('AI')}>
                Hand back to AI
              </button>
            )}
          </div>
          <ol className="messages">
            {conversation.messages.map((m) => (
              <li key={m.id} className={`message message-${m.author}`}>
                <span className="message-author">{m.author === 'ai' ? 'AI' : 'Customer'}</span>
                {m.body}
                <time className="muted">{new Date(m.createdAt).toLocaleTimeString()}</time>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
