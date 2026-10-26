// The stubbed AI sender. It never calls a real AI or a real SMS service: it writes a fixed,
// friendly reply and "sends" it by keeping it in memory. A real version would call an AI model
// and then Twilio's "send message" API here, and nothing else would change.
//
// It is an object so tests can watch it (vi.spyOn(aiSender, 'send')) and count real sends.

export interface OutgoingSms {
  to: string;
  from: string;
  body: string;
}

/** Everything "sent" since the process started. Only for tests and demos. */
export const sentMessages: OutgoingSms[] = [];

function writeReply(companyName: string): string {
  return `Thanks for texting ${companyName}! We got your message and someone will get back to you shortly.`;
}

async function send(sms: OutgoingSms): Promise<void> {
  sentMessages.push(sms);
}

export const aiSender = { writeReply, send };
