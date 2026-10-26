// Every call to the API goes through apiFetch. It adds the X-Demo-User header (the mock login)
// and turns error answers into an ApiError with the API's message, so screens can show it.

// The two seeded users and their company's SMS number (see src/scripts/seed.ts). The mock login
// has no "list users" endpoint, so they are listed here.
export const DEMO_USERS = [
  { email: 'alice@company-a.test', label: 'Alice (Company A)', companyNumber: '+12125550100' },
  { email: 'bob@company-b.test', label: 'Bob (Company B)', companyNumber: '+13125550100' },
];

export interface Lead {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  status: 'new' | 'contacted' | 'qualified' | 'closed';
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** null until the customer has texted. */
  conversationId: string | null;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  author: 'customer' | 'ai';
  body: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  leadId: string;
  mode: 'AI' | 'MANUAL';
  updatedAt: string;
  messages: Message[];
}

export const LEAD_STATUSES: Lead['status'][] = ['new', 'contacted', 'qualified', 'closed'];

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `user` is the X-Demo-User email, or null for the webhook (Twilio isn't a user). */
export async function apiFetch<T>(
  user: string | null,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (user) headers['X-Demo-User'] = user;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // The API answers errors as { error: { message, details: [{ path, message }] } }.
    const details = (data?.error?.details ?? []) as { path: string; message: string }[];
    const message =
      details.length > 0
        ? details.map((d) => `${d.path}: ${d.message}`).join('; ')
        : (data?.error?.message ?? `Request failed (${res.status})`);
    throw new ApiError(res.status, message);
  }
  return data as T;
}
