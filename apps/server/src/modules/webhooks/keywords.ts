// Carrier-standard SMS keywords (the set Twilio's default opt-out handling recognizes). They count
// only when they are the whole message, ignoring case, spaces and punctuation: "Stop!" opts out,
// "please don't stop" does not.
const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const OPT_IN = new Set(['START', 'UNSTOP', 'YES']);
const HELP = new Set(['HELP', 'INFO']);

export type Keyword = 'opt_out' | 'opt_in' | 'help';

export function classifyKeyword(body: string): Keyword | null {
  const word = body.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (OPT_OUT.has(word)) return 'opt_out';
  if (OPT_IN.has(word)) return 'opt_in';
  if (HELP.has(word)) return 'help';
  return null;
}
