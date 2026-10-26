// The pretend AI. It never calls a real AI service: it picks a friendly canned reply based on
// words in the customer's latest message. Always the same answer for the same input, so tests are
// predictable. A real AI would replace `generateReply` and nothing else.

export interface AiInput {
  businessName: string;
  /** This conversation only, oldest first. Never another business's or another customer's. */
  messages: { author: 'lead' | 'ai' | 'human' | 'system'; body: string }[];
}

async function generateReply({ businessName, messages }: AiInput): Promise<string> {
  const latest = (messages.filter((m) => m.author === 'lead').at(-1)?.body ?? '').toLowerCase();

  if (/(urgent|emergency|asap|leak|flood|burst)/.test(latest)) {
    return `Thanks for contacting ${businessName}. Sorry to hear that! Someone will call you as soon as possible. Is this the best number to reach you?`;
  }
  if (/(price|cost|quote|how much|estimate)/.test(latest)) {
    return `Thanks for asking ${businessName}! A team member will send you a quote shortly. What's the best time to reach you?`;
  }
  if (/(book|appointment|schedule|available|weekend|today|tomorrow)/.test(latest)) {
    return `Thanks for reaching out to ${businessName}! We'd be happy to find a time for you. Which day and time work best?`;
  }
  return `Hi! Thanks for texting ${businessName}. We got your message and will get back to you soon. What's a good time to call you?`;
}

// Exported as an object so tests can swap a function out (for example, to make the AI fail).
export const mockAi = { generateReply };
