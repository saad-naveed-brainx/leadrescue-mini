# Sample inbound SMS payloads

The form fields Twilio posts to `POST /webhooks/twilio/inbound`, as JSON for readability. All numbers are fictional (555-01xx).

| File | What it shows |
|---|---|
| `inbound-new-lead.json` | A number nobody has seen texts Acme: a new lead, conversation and message are created and an AI reply is queued. |
| `inbound-existing-lead.json` | Seeded lead Maria Lopez texts Acme: matched to her existing lead, no new lead. |
| `inbound-duplicate.json` | Fixed `MessageSid`: send it twice, the second is acknowledged but stores nothing. |
| `inbound-stop.json` | `STOP`: the number is opted out and pending automation is cancelled. |
| `inbound-start.json` | `START`: the opt-out is lifted. |
| `inbound-other-tenant.json` | The same customer texts Bright Dental's number instead: it lands in Bright's leads, not Acme's. |

Send one with a valid signature (API running, `.env` in place):

```bash
npm run send-inbound -- --file docs/sample-payloads/inbound-new-lead.json
```

Without `MessageSid` in the file, each send gets a fresh random id. Command-line flags (`--from`, `--to`, `--body`, `--sid`) override the file.
