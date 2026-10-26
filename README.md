# LeadRescue Mini

A small slice of LeadRescue AI: a **multi-tenant lead API** with a **simulated Twilio inbound-SMS webhook** and an **AI-to-human hand-off**.

Two companies (Company A and Company B) each receive customer texts. An incoming text creates or finds the lead and its conversation and saves the message. A stubbed AI answers it. A staff member can switch the conversation to MANUAL, and from then on the AI stays quiet.

Nothing real is called: the login, Twilio and the AI are all mocks. There are no API keys anywhere.

**Stack:** Node.js 22+ · Express 5 · TypeScript · PostgreSQL 17 (Docker) · plain parameterized SQL with `pg` · zod for validation · vitest + supertest for tests.

---

## 1. Install and run

You need **Node.js 22 or newer**, **npm**, and **Docker** (for PostgreSQL).

```bash
npm install
cp .env.example .env
npm run db:up        # starts PostgreSQL in Docker (host port 55432)
npm run db:setup     # creates the tables, then adds the seed data
npm run dev          # API on http://localhost:4000 (restarts on file changes)
```

`npm start` runs the API without watching for changes. Stop it with Ctrl-C.

### Optional web UI

With the API running, in a second terminal:

```bash
npm run dev:web      # http://localhost:5173
```

Pick the user at the top right (Alice = Company A, Bob = Company B). Then:

- **Leads:** the company's leads, a form to add one, and each lead's status (saved as soon as you pick it) and notes (Save button; an empty box clears them).
- **Simulate an incoming SMS:** posts to the webhook as Twilio would. Choose which company's number is texted. **Send again (same messageSid)** repeats the last one, to show it is stored once.
- **Conversation:** **Open** on a lead shows its messages and the switch between **Take over (MANUAL)** and **Hand back to AI**. Texts that arrive while it is MANUAL are saved with no AI reply. It calls the API through Vite's proxy (`/api/...` → `localhost:4000`), so the API needs no CORS settings.

### Tests

```bash
npm test             # 36 tests against a separate test database
npm run check        # typecheck + lint + tests
```

The tests use their own database, `leadrescue_test`. Docker creates it the first time it starts, and every `npm test` rebuilds its tables from the migration. The dev database is never touched.

### Seed data

| Company   | Its SMS number (`toNumber`) | User (`X-Demo-User`)   | Seeded leads                                            |
| --------- | --------------------------- | ---------------------- | ------------------------------------------------------- |
| Company A | `+12125550100`              | `alice@company-a.test` | Maria Lopez `+16465550110`, James Carter `+16465550111` |
| Company B | `+13125550100`              | `bob@company-b.test`   | Sam Rivera `+17735550110`                               |

All data is fictional: 555-01xx numbers are reserved for fiction, and `.test` addresses can't exist.

---

## 2. Endpoints

Every `/leads` and `/conversations` request needs the **`X-Demo-User`** header (see §4). The webhook does not, because Twilio isn't a user.

| Method  | Path                         | What it does                                                                     |
| ------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `GET`   | `/leads`                     | Your company's leads, newest first                                               |
| `POST`  | `/leads`                     | Create a lead: `name`, `phone` (required); `email`, `status`, `notes` (optional) |
| `GET`   | `/leads/:id`                 | One lead                                                                         |
| `PATCH` | `/leads/:id`                 | Change `status` and/or `notes` (`null` clears the notes)                         |
| `POST`  | `/webhooks/twilio/inbound`   | Simulated incoming SMS: `messageSid`, `toNumber`, `fromNumber`, `body`           |
| `POST`  | `/conversations/:id/handoff` | `{"mode": "MANUAL"}` to take over, `{"mode": "AI"}` to hand back                 |
| `GET`   | `/conversations/:id`         | The conversation's mode and all its messages, oldest first                       |

- **Phone numbers** use international format, for example `+12125550100`.
- **Lead statuses:** `new`, `contacted`, `qualified`, `closed`.
- **Errors** always look like `{"error": {"code", "message", "details"}}`.

| Status | When                                                       |
| ------ | ---------------------------------------------------------- |
| 400    | Invalid or unknown fields, or broken JSON                  |
| 401    | `X-Demo-User` missing or unknown                           |
| 404    | Not found, **including another company's record**          |
| 409    | A lead with this phone already exists in your company      |
| 500    | Unexpected failure; the answer contains no internal detail |

### Examples

```bash
A='X-Demo-User: alice@company-a.test'
B='X-Demo-User: bob@company-b.test'
J='Content-Type: application/json'
```

**Create a lead for Company A, then list as A and as B:**

```bash
curl -s -X POST localhost:4000/leads -H "$A" -H "$J" \
  -d '{"name":"Grace Kim","phone":"+16465550150","notes":"Wants a quote"}'
# 201 {"id":"<lead id>","name":"Grace Kim","phone":"+16465550150","status":"new",...}

curl -s localhost:4000/leads -H "$A"   # includes Grace Kim
curl -s localhost:4000/leads -H "$B"   # only Sam Rivera
```

**Update the lead as A; try the same as B:**

```bash
curl -s -X PATCH localhost:4000/leads/<lead id> -H "$A" -H "$J" -d '{"status":"contacted"}'
# 200 {..."status":"contacted"...}

curl -s -X PATCH localhost:4000/leads/<lead id> -H "$B" -H "$J" -d '{"status":"closed"}'
# 404 {"error":{"code":"NOT_FOUND","message":"Lead not found"}}  (and nothing changes)
```

**A customer texts Company A. Send it twice: the second is recognised as a repeat:**

```bash
SMS='{"messageSid":"SM001","toNumber":"+12125550100","fromNumber":"+16465550199","body":"Do you do weekend callouts?"}'

curl -s -X POST localhost:4000/webhooks/twilio/inbound -H "$J" -d "$SMS"
# {"result":"saved","leadId":"...","conversationId":"<conversation id>","messageId":"...",
#  "aiReply":{"sent":true,"messageId":"..."}}

curl -s -X POST localhost:4000/webhooks/twilio/inbound -H "$J" -d "$SMS"
# {"result":"duplicate"}   no new message, no AI work
```

To send copies at the same moment:

```bash
for i in 1 2 3 4 5; do curl -s -X POST localhost:4000/webhooks/twilio/inbound -H "$J" -d "$SMS" & done; wait
```

**Hand the conversation to a person; the next text gets no AI reply:**

```bash
curl -s -X POST localhost:4000/conversations/<conversation id>/handoff -H "$A" -H "$J" -d '{"mode":"MANUAL"}'
# {"id":"...","mode":"MANUAL",...}

curl -s -X POST localhost:4000/webhooks/twilio/inbound -H "$J" \
  -d '{"messageSid":"SM002","toNumber":"+12125550100","fromNumber":"+16465550199","body":"Hello?"}'
# {"result":"saved",...,"aiReply":{"sent":false,"reason":"manual_mode"}}

curl -s localhost:4000/conversations/<conversation id> -H "$A"
# mode MANUAL; messages: customer text, AI reply, customer "Hello?" (no second AI reply)
```

**Restart:** stop the API with Ctrl-C and start it again. Leads, conversations and messages are all in PostgreSQL, so the same `GET` calls return the same data.

---

## 3. How the important parts work

### Companies kept apart (tenant isolation)

- **The company always comes from the user.** The server looks up the `X-Demo-User` user and their company in the database. A `tenantId` in the body is refused with 400, because request bodies allow only known fields. One in the query string or a header is simply ignored.
- **Every query filters by company.** Each query on company data includes `WHERE tenant_id = $1`. Another company's id therefore matches no row, and the answer is **404, as if it didn't exist**: never 403, which would confirm the record exists, and never the data.
- **The database enforces it as well.** Conversations and messages point at their parent with `(tenant_id, parent_id)` foreign keys. The database refuses, for example, a message for Company B attached to Company A's conversation, even if the code had a bug.
- **SQL is always parameterized** (`$1, $2, …`). User input is never pasted into SQL text.

### Repeated webhook delivery (idempotency)

Twilio may deliver the same message more than once. `messages.provider_message_id` (the `messageSid`) is **UNIQUE**, and the message is saved with `INSERT … ON CONFLICT DO NOTHING`. Saving a message is one transaction:

1. Find the company from `toNumber`.
2. Find or create the lead.
3. Find or create the conversation.
4. Insert the message.

When copies arrive **at the same moment**, the database lets one insert through. The others wait for it to finish, then find the row already there and insert nothing. The lead and the conversation use the same pattern, so the copies all end up with one lead and one conversation.

A repeat answers `200 {"result":"duplicate"}`, so Twilio stops retrying, and **starts no AI work**. A second rule makes duplicate AI work impossible even if the AI step runs twice: `messages.reply_to_message_id` is UNIQUE, so the database allows at most **one AI reply per customer message**.

### AI ↔ MANUAL hand-off, and the race between them

`processPendingAiReply(conversationId)` in `src/services/aiReply.ts` is the only place an AI reply is sent. It runs these steps in one transaction:

1. **Lock the conversation row** (`SELECT … FOR UPDATE`).
2. **Read the mode, now, under that lock.** If it isn't `AI`, stop.
3. Check that the customer's latest message hasn't been answered yet.
4. Save the reply, call the stubbed sender, commit. Committing releases the lock.

The hand-off (`POST /conversations/:id/handoff`) is an `UPDATE` of **the same row**, so it needs the same lock:

- If the AI is in the middle of sending, the hand-off **waits** until that send is finished.
- If the hand-off got there first, the AI step waits for it, then reads `MANUAL` and sends nothing.

So **once a hand-off to MANUAL has been confirmed**, no AI message can go out for that conversation. A reply that had already started before the hand-off may finish, and the hand-off answers only after it has.

Here `processPendingAiReply` runs straight after the webhook saves the message. In production it would run in a background worker, and the same lock and check would apply unchanged.

---

## 4. Assumptions

- **Mock login (`X-Demo-User`), and why it is not production authentication.** The header names a seeded user by email, and the server looks up their company. **Anyone who knows or guesses an email can act as that user:**
  - there is no password and nothing secret
  - no signature, so the header can't be proven genuine
  - no expiry and no way to revoke it

  Production would use a real identity provider (OIDC, or a service like Auth0/Clerk). The API would then verify a signed, expiring token on every request, and would still look up the user's company on the server exactly as it does now.

- **One SMS number per company** (`tenants.phone_number`). It is unique, so `toNumber` always picks exactly one company.
- **One lead per phone number per company**, and one conversation per lead. Two companies may each have a lead with the same phone; they are separate leads.
- A text to a number that belongs to no company answers **404** and stores nothing.
- A lead created by an SMS has no name until someone adds one. Leads created through the API need a name and a phone.
- **The AI is a stub:** a fixed polite reply that mentions the company's name. "Sending" records the message in memory (`sentMessages`) and in the `messages` table. Nothing leaves the machine.
- Phone numbers are accepted only in E.164 format (`+` and 8–15 digits). They aren't reformatted.

### Twilio signature verification (not implemented in this mock)

Real Twilio signs every webhook. To add it in production:

1. Keep the Twilio **Auth Token** as a secret (environment variable or secrets manager), never in the repo.
2. Accept Twilio's real body format (`application/x-www-form-urlencoded`, with fields `MessageSid`, `To`, `From`, `Body`).
3. **Before reading or storing anything**, rebuild the signature: take the **public URL Twilio called**, append every POST field sorted by name (name + value), compute HMAC-SHA1 with the Auth Token, and Base64-encode it. The official `twilio` package's `validateRequest` does this.
4. Compare the result with the `X-Twilio-Signature` header using a **constant-time comparison**. If it doesn't match, answer 403 and stop.
5. Build the URL from a configured public base URL, **not from the request's Host header**, which a caller could fake. Use HTTPS only, and rate-limit the endpoint.

---

## 5. Known limitations

- **Crash at the worst moment.** If the server crashes after the AI stub "sends" but before the transaction commits, the reply row is rolled back, and a later run could send that reply again. The fix is to save a "sending" marker first and, after a crash, ask the SMS provider whether the message went out before resending.
- **The AI step runs inside the webhook request**, not in a background worker. A slow AI makes Twilio wait. If the server stops between saving the message and replying, the reply is only sent when `processPendingAiReply` is run again for that conversation. Nothing runs it automatically yet.
- **Handing back to AI doesn't reply by itself** to messages that arrived during MANUAL. The next customer text, or a call to `processPendingAiReply`, does.
- **The mock login is not security** (see §4). There are no roles: any user of a company can do everything in that company.
- **`GET /leads` returns at most 200 leads**, with no paging, search or filter.
- **No Twilio signature check, rate limiting, security headers or CORS.** These are deliberate omissions for this offline exercise.
- **The web UI is minimal**: leads, simulated SMS and conversations, with no live updates (it refreshes after your own actions). It has no automated tests; the API tests cover the rules.

## 6. What I would improve with another day

1. **A background worker** for `processPendingAiReply`: a job saved in the same transaction as the incoming message, with retries. Plus the crash-safe "sending" marker and provider check described above.
2. **Real authentication** (OIDC tokens) and **roles** (owner/manager/member). Also PostgreSQL row-level security, as a second wall between companies.
3. **Twilio signature verification**, the real form-encoded payload, rate limits and security headers.
4. **Customer opt-out (STOP/START)**, honoured by the same lock as the hand-off, and an **audit log** of who switched modes and when.
5. **Lead list paging and search**, and UI tests.
6. **Docker Compose for the API too**, so one command starts everything, and CI running `npm run check`.

---

## 7. Project layout

```
migrations/0001_init.sql        tables, keys, uniqueness rules
src/server.ts                   starts the API, clean shutdown
src/app.ts                      middleware and routes, in order
src/config.ts, src/db.ts        settings; one shared PostgreSQL pool + withTransaction
src/validation.ts               every request body's rules (zod)
src/middleware/auth.ts          mock X-Demo-User login → user + company
src/middleware/errors.ts        one error shape; nothing internal leaks
src/routes/                     leads, conversations, webhooks (thin: validate → service)
src/services/leads.ts           lead queries, all filtered by company
src/services/inboundSms.ts      saving an incoming SMS, duplicates included
src/services/aiReply.ts         processPendingAiReply: lock, check mode, send
src/services/aiSender.ts        the stubbed AI sender
src/services/conversations.ts   hand-off and conversation view
src/scripts/                    migrate, seed
test/                           tenant isolation, leads, webhook duplicates, hand-off and races
web/                            optional React UI (Vite): leads, simulated SMS, conversation + hand-off
```

The tests cover the three the brief requires, among others:

| Required test                                                                                          | Where                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Cross-tenant access denied                                                                             | `test/tenant-isolation.test.ts` |
| Duplicate webhook processed once (in a row, and 10 at the same moment)                                 | `test/webhook.test.ts`          |
| Manual hand-off prevents the AI send (including a hand-off arriving mid-send, and 50 randomized races) | `test/handoff.test.ts`          |

## 8. Time spent and AI tools

- **Time spent:** _to be filled in by the candidate._
- **AI tools used:** Claude Code (Anthropic's coding assistant), for design, code, tests and this README.
