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

In a **second terminal**, start the background worker that sends the AI replies:

```bash
npm run worker       # runs 5 jobs at a time (WORKER_CONCURRENCY); start more for more throughput
```

`npm start` runs the API without watching for changes. Stop either with Ctrl-C: the worker finishes the jobs in progress first.

### Optional web UI

With the API running, in a second terminal:

```bash
npm run dev:web      # http://localhost:5173
```

Pick the user at the top right (Alice = Company A, Bob = Company B). Then:

- **Leads:** the company's leads (25 at a time, with **Load more** and a **status filter**), a form to add one, and each lead's status (saved as soon as you pick it) and notes (Save button; an empty box clears them).
- **Simulate an incoming SMS:** posts to the webhook as Twilio would. Choose which company's number is texted. **Send again (same messageSid)** repeats the last one, to show it is stored once.
- **Conversation:** **Open** on a lead shows its messages and the switch between **Take over (MANUAL)** and **Hand back to AI**. Texts that arrive while it is MANUAL are saved with no AI reply. It calls the API through Vite's proxy (`/api/...` → `localhost:4000`), so the API needs no CORS settings.

### Tests

```bash
npm test             # 62 tests against a separate test database
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

| Method  | Path                         | What it does                                                                                                                            |
| ------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/leads`                     | Your company's leads, newest first, one page at a time: `?limit=` (1–100, default 50), `?status=`, `?cursor=` → `{ leads, nextCursor }` |
| `POST`  | `/leads`                     | Create a lead: `name`, `phone` (required); `email`, `status`, `notes` (optional)                                                        |
| `GET`   | `/leads/:id`                 | One lead                                                                                                                                |
| `PATCH` | `/leads/:id`                 | Change `status` and/or `notes` (`null` clears the notes)                                                                                |
| `POST`  | `/webhooks/twilio/inbound`   | Simulated incoming SMS: `messageSid`, `toNumber`, `fromNumber`, `body`                                                                  |
| `POST`  | `/conversations/:id/handoff` | `{"mode": "MANUAL"}` to take over, `{"mode": "AI"}` to hand back                                                                        |
| `GET`   | `/conversations/:id`         | The conversation's mode and all its messages, oldest first                                                                              |

- **Phone numbers** use international format, for example `+12125550100`.
- **Lead statuses:** `new`, `contacted`, `qualified`, `closed`.
- **Errors** always look like `{"error": {"code", "message", "details"}}`.

| Status | When                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| 400    | Invalid or unknown fields, or broken JSON                                    |
| 401    | `X-Demo-User` missing or unknown                                             |
| 404    | Not found, **including another company's record**                            |
| 409    | A lead with this phone already exists in your company                        |
| 500    | Unexpected failure; the answer contains no internal detail                   |
| 503    | Hand-off only: a reply is being sent and didn't finish within 5 s; try again |

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

**Paging and filtering the list:**

```bash
curl -s "localhost:4000/leads?limit=2" -H "$A"
# {"leads":[ ...2 leads... ],"nextCursor":"eyJ0aW1lIjoi..."}     null on the last page

curl -s "localhost:4000/leads?limit=2&cursor=<nextCursor>" -H "$A"   # the next 2
curl -s "localhost:4000/leads?status=new" -H "$A"                  # only status "new"
```

The list uses **keyset paging**: the cursor means "continue after this lead" (its time and id), so page 500 is as fast as page 1, and leads added in the meantime don't shift or repeat what you see. Page numbers (`OFFSET`) would make the database read and skip every earlier row: about 0.05 ms vs 13 ms at 90,000 leads in, measured on 100,000 leads. Indexes in `migrations/0004_leads_paging_indexes.sql` match the order exactly, with and without the status filter.

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
#  "aiReply":"queued"}        a moment later the worker sends the AI reply

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
# {"result":"saved",...,"aiReply":"queued"}   the worker runs the job, sees MANUAL, sends nothing

curl -s localhost:4000/conversations/<conversation id> -H "$A"
# mode MANUAL; messages: customer text, AI reply, customer "Hello?" (no second AI reply)
```

**Restart:** stop the API and the worker with Ctrl-C and start them again. Leads, conversations, messages and waiting jobs are all in PostgreSQL, so nothing is lost: the same `GET` calls return the same data, and the worker picks up any jobs still waiting.

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

A repeat answers `200 {"result":"duplicate"}`, so Twilio stops retrying, and **queues no AI work**: the AI reply job is saved in the same transaction as the message, so a repeat never gets that far. A second rule makes duplicate AI work impossible even if the AI step runs twice: `messages.reply_to_message_id` is UNIQUE, so the database allows at most **one AI reply per customer message**.

### AI ↔ MANUAL hand-off, and the race between them

`processPendingAiReply(conversationId)` in `src/services/aiReply.ts` is the only place an AI reply is sent. The worker calls it for each job. It works in four steps:

| Step          | What happens                                                                                                                             | Conversation lock                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **A. Write**  | Ask the AI for the reply text (slow, seconds)                                                                                            | ❌ not held, so a hand-off never waits for the AI |
| **B. Claim**  | Take the lock. Check **again, fresh**: mode still `AI`? latest customer message still unanswered? Save the reply as `sending` and commit | ✅                                                |
| **C. Send**   | Call the SMS provider                                                                                                                    | ✅                                                |
| **D. Record** | Mark the reply `sent` with the provider's message id. Release the lock                                                                   | ✅                                                |

**The lock** is a PostgreSQL _advisory lock_ (`src/services/conversationLock.ts`) named after the conversation. It belongs to the worker's **connection**, not to a transaction, so it stays held across the commits in B and D. If the worker dies, its connection drops and PostgreSQL releases the lock by itself.

**The hand-off** (`POST /conversations/:id/handoff`) takes **the same lock** before changing the mode:

- If a reply is between B and D, the hand-off **waits** until it has been sent and recorded.
- If the hand-off got there first, the AI step reads `MANUAL` in step B and sends nothing.
- If the lock isn't free within **5 seconds** (e.g. a stuck provider), the hand-off answers **503 `CONVERSATION_BUSY`** ("try again") instead of hanging, and changes nothing.

So **once a hand-off to MANUAL has been confirmed**, no AI message can go out for that conversation. A reply already between B and D finishes first; the hand-off answers only after it has.

### A crash in the middle of sending never sends twice

The dangerous moment is after the provider has the SMS (C) but before we recorded it (D). Because step B **committed** the reply as `sending`, that record survives a crash. When the job is retried:

1. The worker finds the reply still `sending`.
2. It **asks the provider whether it already went out** (`aiSender.findSent`). If yes, it just records `sent`: **no second SMS.**
3. If the provider never got it, it sends now. If the conversation was handed to MANUAL meanwhile, the reply is marked `cancelled` instead, and it isn't shown in the conversation.

A test starts a **real worker process**, kills it (`SIGKILL`) right after the provider got the SMS, and checks that the retry produces exactly one SMS.

### Background worker and job queue (built for volume)

The webhook does **not** call the AI. It saves the message **and an `ai_reply` job in the same transaction**, then answers Twilio straight away. A message can't be saved without its job, or the other way round. A separate worker process (`npm run worker`) does the slow part:

- **Queue = a `jobs` table in PostgreSQL** (`migrations/0002_jobs.sql`). All queue SQL is in `src/services/queue.ts` (`enqueueJob`, `claimJobs`, `finishJob`, `failJob`, `releaseExpiredJobs`). Swapping it for Redis/SQS later means changing only that file.
  - Why not Redis: the job must be saved in the same transaction as the message. With Redis that needs an extra "outbox" table, and PostgreSQL does the same amount of work either way.
- **Parallel workers.** Each worker process runs `WORKER_CONCURRENCY` jobs at the same time, and you can start as many worker processes as you like. `FOR UPDATE SKIP LOCKED` hands each job to exactly one worker, and workers skip each other's jobs instead of waiting.
- **One job per customer message** (`dedupe_key` UNIQUE): no duplicate AI work.
- **Retries:** a job that throws (e.g. the AI is down) is retried after 2, 4, 8 … seconds (at most 60), and marked `failed` after 5 attempts.
- **Crashed workers:** a running job has a time limit (`JOB_LEASE_SECONDS`). If its worker dies, the job goes back to the queue and another worker does it. A worker whose time limit ran out can't mark the job done any more, because its attempt number no longer matches.
- **Clean shutdown:** on Ctrl-C or a deploy, a worker takes no new jobs and finishes the ones in progress.
- **Small table:** finished jobs older than 24 hours are deleted. Only pending jobs are indexed for "what's due next".
- **Database connections:** `DB_POOL_SIZE` per process. A worker refuses to start if `WORKER_CONCURRENCY` doesn't leave room for its own housekeeping connections.

The worker calls the same `processPendingAiReply`, so the lock and the mode check above apply unchanged. If two workers ever ran the same job, the lock and the one-reply-per-message rule still allow only one reply.

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
- **The AI and SMS provider are stubs** (`src/services/aiSender.ts`): a fixed polite reply that mentions the company's name. "Sending" writes a row to `mock_sms_sent`, which plays the provider's own record of what it sent. Nothing leaves the machine.
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

- **"Did it go out?" with real Twilio.** The mock provider can be asked by our reply's id. Twilio has no such key: production would save Twilio's message id the moment it answers, and for the remaining gap search Twilio's sent messages by number and time.
- **Handing back to AI doesn't reply by itself** to messages that arrived during MANUAL. Their jobs already finished without sending. The next customer text does get a reply.
- **Workers look for work every 500 ms** (`WORKER_POLL_MS`) rather than being notified, so a reply can take up to half a second longer to start. PostgreSQL `LISTEN/NOTIFY` would remove that delay.
- **The mock login is not security** (see §4). There are no roles: any user of a company can do everything in that company.
- **No search** in `GET /leads` (by name or phone), only the status filter. And no protection against two people editing the same lead at once: the last save wins.
- **No Twilio signature check, rate limiting, security headers or CORS.** These are deliberate omissions for this offline exercise.
- **The web UI is minimal**: leads, simulated SMS and conversations. An open conversation checks for new messages every 2 seconds; the lead list refreshes after your own actions. It has no automated tests; the API tests cover the rules.

## 6. What I would improve with another day

1. **Operations:** a small admin command to list and retry `failed` jobs, queue metrics (pending count, age of the oldest pending job), and an alert when replies stay `sending`.
2. **Real authentication** (OIDC tokens) and **roles** (owner/manager/member). Also PostgreSQL row-level security, as a second wall between companies.
3. **Twilio signature verification**, the real form-encoded payload, rate limits and security headers.
4. **Customer opt-out (STOP/START)**, honoured by the same lock as the hand-off, and an **audit log** of who switched modes and when.
5. **Search** in the lead list, a **"changed by someone else"** check when two people edit the same lead (optimistic concurrency), and UI tests.
6. **Docker Compose for the API too**, so one command starts everything, and CI running `npm run check`.

---

## 7. Project layout

```
migrations/0001_init.sql        tables, keys, uniqueness rules
migrations/0002_jobs.sql        the job queue table
migrations/0003_send_status.sql AI reply progress (sending/sent/cancelled), mock provider table
migrations/0004_leads_paging_indexes.sql  indexes for the paged lead list
src/server.ts                   starts the API, clean shutdown
src/worker.ts                   starts a background worker (npm run worker)
src/app.ts                      middleware and routes, in order
src/config.ts, src/db.ts        settings; one shared PostgreSQL pool + withTransaction
src/validation.ts               every request body's rules (zod)
src/middleware/auth.ts          mock X-Demo-User login → user + company
src/middleware/errors.ts        one error shape; nothing internal leaks
src/routes/                     leads, conversations, webhooks (thin: validate → service)
src/services/leads.ts           lead queries, all filtered by company
src/services/inboundSms.ts      saving an incoming SMS, duplicates included
src/services/aiReply.ts         processPendingAiReply: write, claim, send, record (crash-safe)
src/services/conversationLock.ts the per-conversation lock shared by AI sends and the hand-off
src/services/aiSender.ts        the stubbed AI and SMS provider (send, "did you send this?")
src/services/queue.ts           the job queue: all its SQL in one file
src/services/worker.ts          runs jobs: parallel slots, retries, housekeeping, clean stop
src/services/conversations.ts   hand-off and conversation view
src/scripts/                    migrate, seed
test/                           tenant isolation, leads, webhook duplicates, hand-off and races, queue/workers
web/                            optional React UI (Vite): leads, simulated SMS, conversation + hand-off
```

The tests cover the three the brief requires, among others:

| Required test                                                                                          | Where                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Cross-tenant access denied                                                                             | `test/tenant-isolation.test.ts` |
| Duplicate webhook processed once (in a row, and 10 at the same moment)                                 | `test/webhook.test.ts`          |
| Manual hand-off prevents the AI send (including a hand-off arriving mid-send, and 50 randomized races) | `test/handoff.test.ts`          |

## 8. Time spent and AI tools

- **Time spent on 2026-10-27:** about 2.5 hours (job queue and parallel workers, crash-safe sending, lead list paging, UI polish). Work on earlier days is not included in this figure.
- **AI tools used:** Claude Code (Anthropic's coding assistant), for design, code, tests and this README.
