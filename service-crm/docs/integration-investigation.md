# CRM integrations — investigation, decisions and open questions

Status: **investigation only.** Nothing in this document has been built,
connected or enabled. No phone, Podium, Google or expanded AroFlo integration
starts until the owner approves a specific phase.

Last updated: 16 Nov 2026. Provider facts were checked against each
provider's official documentation on that date and must be re-tested against
the Just Trades accounts before any build.

---

## 1. Standing rules (unchanged)

- Podium's missed-call text service and every current Just Trades customer
  message stay exactly as they are. No automatic messages are activated and no
  customer wording changes without separate approval.
- Nothing is written back to AroFlo without separate approval. AroFlo access
  stays GET-only.
- Integrations start read-only: they read information and create drafts or
  Needs Attention items for staff to act on.
- ServiceTitan is only a reference for the *kind* of workflow and reporting
  features. No ServiceTitan branding, wording, visual design or exact
  processes are copied.
- No additional provider or API costs are approved yet. No other provider is to
  be recommended for purchase until it's known what Podium, Google and JET
  already provide.
- Nothing is guessed: unconfirmed matches and attributions are shown as
  possibilities for staff, never recorded as fact.

## 2. Decisions recorded (owner, 16 Nov 2026)

| # | Topic | Decision |
|---|---|---|
| 1 | Customer phone numbers | Stored securely in the CRM. Visible to Admin and office Staff only — never Technician accounts. Included in backups (customer history, possible future JMS). *Replaces the earlier rule that the CRM never stores customer phone numbers; the rule for emails and street addresses is unchanged unless separately decided — see §3, Q1.* |
| 2 | Confident customer match | An exact phone-number match to **one** AroFlo client or **one** Podium contact. Several matches, or AroFlo and Podium disagreeing → never chosen automatically; staff see the possible matches with enough safe information to pick. Never match on name alone. |
| 3 | Transferred calls | The draft Contact belongs to the staff member who **finishes** the call. The call history also records who first answered and anyone it was transferred through, **where Podium provides that**. |
| 4 | Short / outgoing calls | No minimum duration: every answered inbound call creates one draft. Spam, wrong numbers and non-enquiries are completed as Not Qualified / not a lead with a comment. Outgoing calls are logged; how they join an existing Contact without duplicates is to be designed (see §5.3). |
| 5 | Podium AI | AI-handled enquiries are a separate group awaiting human follow-up. The AI only gathers details; it never books a Lead. No completed Contact until Jade or Kurt calls/texts the customer and confirms the outcome. Shown in Needs Attention with the available details/messages/summary and a Create contact button. |
| 6 | Phone numbers | Main business numbers: an 08 landline and an 04 mobile. Google/campaign tracking numbers to be confirmed by Kurt. No number is treated as a tracking number until confirmed. |
| 7 | Call bubble | Admin and office Staff only, connected to Calls & Contacts. Never Technician accounts. All logged-in office staff see an incoming call; the CRM shows clearly when someone has answered or claimed it, and never creates duplicate drafts. |
| 8 | Privacy | Expected turnover ≈ $1M (first year), so likely below the $3M Privacy Act threshold — but the system is designed to Privacy-Act-style standards anyway: restricted access, secure storage, clear privacy wording, audit history, keeping only what serves a genuine business purpose. Kurt and the owner manage the business accounts. |
| 9 | Retention / backups | Retained and backed up: completed Contacts; customer phone numbers (restricted); call direction, outcome, staff member, start time, duration; Podium call and conversation IDs; AroFlo client IDs; customer matches; advertising attribution; links between customers, Contacts, jobs, sales, callbacks and cancellations; archived/dismissed records needed for history and audit. Call recordings stay in Podium (link only). Raw webhook deliveries kept ~30 days for troubleshooting once converted into proper records. |
| 10 | Website | Website management, Podium webchat and GCLID details to follow. No website assumptions or changes. |
| 11 | Google Ads | Kurt manages the account; ownership, forwarding numbers, auto-tagging and access details to follow. |
| 12 | Costs / providers | No extra costs approved. Kurt will likely use JET for this side of the business; what JET manages and what access/tracking it provides is to be clarified. List likely costs separately; recommend no purchases yet. |
| 13 | AroFlo client ID | May be stored securely as an internal identifier (not displayed unnecessarily), included in backups, using whichever design gives reliable matching and a future customer/job timeline without copying unnecessary customer information. |
| 14 | Stage 4 | Finish the existing Needs Attention design first, without Podium/Google/expanded AroFlo. Design it so missed/abandoned calls, after-hours AI enquiries, webchat enquiries, draft Contacts, returned missed calls and other integration issues can be added later. See `docs/stage4-needs-attention-design.md`. |
| — | Long-term direction | AroFlo stays the source for jobs, scheduling, quotes, invoices and payments; Podium for calls and messages; the CRM connects them into one staff workflow, customer timeline, Needs Attention and reporting layer. The design must not lock AroFlo in as the only possible source of jobs and customers, so the CRM can gradually become a Just Trades JMS if practical and safe. |

## 3. Still needs clarification from the owner

1. **Emails and street addresses.** The phone-number rule has changed. Should
   customer **emails** and **street addresses** also be stored (restricted like
   phone numbers), or does the original "never stored" rule still apply to them?
   A future JMS would need addresses; for now the recommendation is to keep
   emails and full street addresses out until a phase needs them.
2. **Phone-number protection method** (see §6.2): field-level encryption with
   the key held outside the database (recommended), or access control only.
   Encryption means a backup can't be read without the key, so the key must be
   stored safely and separately (e.g. in the owners' password manager).
3. **Outgoing calls** (§5.3): confirm the recommended handling — outgoing calls
   are logged and linked, but don't create a draft automatically unless staff
   choose "Create contact"; a returned missed call / AI enquiry is marked as
   returned.
4. **"Claimed"** on the call bubble: is answering the call (from Podium) enough,
   or should office staff also be able to click "I'll take this" before/without
   answering (e.g. a missed call someone is calling back)?
5. **Who is "office Staff"?** Today the CRM has Admin, Staff and Technician
   accounts. Is every Staff account "office Staff", or do some Staff accounts
   need to be excluded from phone numbers/the bubble?
6. **Stage 4 questions** (permissions, timings, dismissal, September records) —
   see the Stage 4 design document.

## 4. Confirmed capabilities (official documentation, 16 Nov 2026)

### 4.1 Podium
- Developer account (application, a few days' review) → OAuth app → a Podium
  user on the Just Trades account authorises it. Podium must approve API use
  and can revoke it. Rate limit: 300 requests/minute.
- **Calls** (`read_phones`): list (`since`, location) and get by ID. Per call:
  status (answered, missed_call, abandoned, no_answer, directed_to_voicemail,
  forwarded, busy, incoming), direction, start/end, duration (includes ring
  time), customer number, which Podium number was called, location, the staff
  user who handled it (`userUid`), contact, conversation, voicemail flag and
  transcript, `handledByAi` / `aiAbandoned`, and a link to open the call in
  Podium.
- **Webhooks:** `call.received`, `call.completed`, `call.missed`,
  `call.voicemail_left`; `message.received/sent/failed`; contact events;
  review and invoice events. Signed (`Podium-Signature`), must answer within 5
  seconds, retried ~15 times over ~8 hours then disabled. Webhook deliveries
  carry no phone numbers — the call is fetched by ID.
- **Messages/conversations** (`read_messages`): conversations with channel
  (SMS, webchat, Google, Facebook…), assigned user, open/closed; messages per
  conversation; webchat messages record the page URL they came from.
- **Contacts** (`read_contacts`): name, phone numbers, emails, attributes,
  tags. **Users** (`read_users`): staff names/roles, for mapping to CRM accounts.
- **Read-only scopes exist**, so the integration can be given no ability to
  send messages or change contacts.
- Constraints: voicemail recording URLs must not be stored; message attachment
  URLs expire after 7 days; calls coming through third-party call-tracking
  integrations are not included in the call API; data may be processed in the
  US; the API Terms require using data only as the client authorises and
  deleting it on request/termination.

### 4.2 AroFlo
- The CRM already reads the `/v2` API with a token on the live account (GET
  only): business units, tasks (jobs), task labour, invoices, schedules, custom
  fields, clients, locations, users, task types.
- AroFlo's documented API (zone-based) also offers quotes (status, totals,
  accepted/approved dates), payments, notes, substatus, documents (links expire
  after 10 minutes), and a `lastupdate` feed of changed records.
- No webhooks are documented: changes must be polled. Documented limits for
  that API: ~120/minute, ~3/second, 2,000/day (20,000/day for single-record
  look-ups); the change feed doesn't count towards the daily limit.
- No read-only token type is documented; read-only access relies on the CRM
  only sending GET and on the API user's permissions.
- AroFlo already provides quoting, scheduling/dispatch, timesheets, invoicing,
  payments, client portal, its own SMS and reporting.

### 4.3 Google Ads
- Auto-tagging adds GCLID (or GBRAID/WBRAID on iOS) to ad clicks; the website
  must capture and keep it (Google's sample keeps it 90 days).
- `click_view`: a GCLID → campaign, ad group, ad, keyword (one day per query,
  last 90 days only). No search term or landing page per click.
- Google forwarding numbers are available in Australia. `call_view`: caller
  area code (not the full number), start/end, duration, received/missed,
  campaign, ad group. **No caller number, keyword or search term per call.**
- Cost by campaign/ad group/keyword is available; search terms only in
  aggregate (low-volume terms hidden).
- Sending outcomes back: click conversions (GCLID/GBRAID/WBRAID) with an AUD
  value and order ID; call conversions (caller number + start time, Google
  forwarding numbers only); Enhanced Conversions for Leads (hashed phone/email).
  New integrations must use Google's **Data Manager API** (since June 2026).
- API access is granted per Google Cloud project (Explorer/Basic/Standard
  levels); no fees are published.

### 4.4 Phone providers (only if Podium ever proves limiting)
- Aircall, Dialpad and RingCentral document real-time call events, the user
  who answered, transfers and recordings, with Australian numbers. Zoom Phone
  and 3CX need testing. Telstra has no public call-event API.

## 5. Recommendations (updated for the decisions)

### 5.1 Live call bubble (Admin and office Staff only)
- Each Podium call becomes **one** CRM call record keyed by Podium's call ID
  (a unique key in the database), so transfers, retries and several staff
  being logged in can never create a second draft.
- Answered/missed/abandoned and who handled it come from Podium; staff never
  mark them.
- The draft is assigned to the staff member Podium reports as handling the
  call. **Needs Podium:** whether that is the person who finished the call, and
  whether transfers are visible at all. If Podium only gives one user, the CRM
  records that user and cannot show transfer hops.
- "Ringing now" depends on whether `call.received` fires while the phone rings
  (needs Podium/testing). If not, the bubble appears when the call ends as
  "Contact needs completing".
- All office staff see the same call; once a user is known (answered) or
  someone claims it, everyone sees who has it (needs Q4 above).
- Google advertising information is **not** shown in the bubble until a
  confirmed source exists (Podium doesn't know a call came via Google;
  Google's own call data has only area code and time).
- Every answered inbound call creates one draft, however short.

### 5.2 Texts, webchat and Podium AI
- No message becomes a Contact automatically.
- Webchat and after-hours AI enquiries appear in Needs Attention (when that
  phase is approved) with customer details, time received, the messages, any
  Podium summary the API provides, and a Create contact button that opens a
  prefilled draft for staff review.
- AI-handled calls/enquiries are their own group ("Awaiting human follow-up").
- A human text conversation becomes a Contact only when staff create one
  (booking, New Job Cancellation, Pending Cancellation). The CRM doesn't try to
  decide from text that a booking happened.

### 5.3 Outgoing calls (recommendation — needs confirmation, §3 Q3)
- Logged as call records (direction outbound, staff, time, duration, Podium IDs).
- Linked to the customer by confident phone match and shown on the customer
  timeline.
- If the number matches an open Needs Attention item (missed/abandoned call or
  AI/webchat enquiry), that item is marked **"Returned by <staff> at <time>"**
  — it stays open until staff complete it with Create contact or "No contact
  needed".
- No draft is created automatically for outgoing calls; staff use Create
  contact when a genuine conversation happened. This avoids a second Contact
  for an enquiry already being completed.
- If a draft already exists for that customer's earlier call, the outgoing call
  is attached to it rather than creating another.

### 5.4 AroFlo
- Read automatically (when approved): Job Number, Trade/Job type (via existing
  mappings), suburb, client link, schedule and technician, quote status and
  values, invoice and outcome. Polled every 10–15 minutes via the change feed,
  well within limits.
- Keep in AroFlo: scheduling/dispatch, quoting, invoicing, payments, client
  portal and AroFlo's own SMS. The CRM shows read-only summaries, timelines,
  Needs Attention and reports, with links back to AroFlo.

### 5.5 Google advertising attribution
- The Calls & Contacts Lead Source never changes because of advertising data.
- A separate advertising record per enquiry holds what is genuinely available
  (tracking number, campaign, ad group, keyword, ad, landing page,
  GCLID/GBRAID/WBRAID, cost, enquiry time) with **evidence and confidence**.
- Confirmed only from an identifier (GCLID etc.) or a confirmed tracking-number
  rule. Area-code-and-time matches from Google call data are "possible" only.
- Search term per lead is not available from Google.
- Sending outcomes back to Google is a later phase after a privacy review.

### 5.6 Not locking in AroFlo (long-term JMS)
- The CRM gets its **own customer record** (an internal CRM customer ID). AroFlo
  client IDs and Podium contact IDs are stored as **external links** on that
  customer (`provider`, `external_id`), not as the customer's identity. A
  customer can have no AroFlo link, one, or (if AroFlo duplicates exist) more.
- Jobs keep using the AroFlo Job Number today. A future CRM-native job would get
  its own ID and an optional external link to AroFlo, so CRM jobs and AroFlo
  jobs can coexist during any transition.
- Integrations are adapters (Podium, AroFlo, Google) writing into the CRM's own
  tables. Replacing a provider means a new adapter, not a rebuild.
- Nothing in this design makes AroFlo the only possible source of jobs and
  customers.

## 6. Data, security and retention

### 6.1 What the CRM would store (when phases are approved)
- **Customers:** internal ID; protected phone number(s); match status; external
  links (AroFlo client ID, Podium contact ID); created/updated; no emails or
  street addresses unless §3 Q1 decides otherwise.
- **Communication events:** provider, provider call/conversation/message ID
  (unique), type, direction, status/outcome, start, end, duration, number
  called (business line), staff member (mapped from the provider user),
  handled-by-AI flag, link to open it in Podium, linked customer, linked
  Contact.
- **Drafts:** linked to one communication event; status draft / completed /
  dismissed; who completed or dismissed it and why.
- **Advertising attribution:** linked to a Contact or communication event;
  source, identifiers, campaign/ad group/keyword/ad/landing page, cost,
  enquiry time, evidence, confidence.
- **Provider user mapping:** provider user ID → CRM account (Settings).
- **Raw webhook log:** troubleshooting only, deleted after ~30 days.

### 6.2 Security and access
- Phone numbers visible to Admin and office Staff only, never Technician
  accounts, and enforced on the server (not just hidden on screen).
- Recommended: phone numbers encrypted in the database (key outside the
  database) plus a one-way keyed fingerprint for exact matching, so matching
  never needs the readable number. Decision needed (§3 Q2).
- Provider keys and secrets in server settings only — never in the database,
  backups, logs or Activity history.
- Every webhook signature is verified; unsigned or unknown requests are refused.
- Read-only provider permissions only.
- Viewing a phone number can be recorded in Activity history if wanted.

### 6.3 Recommended retention and archiving policy
| Data | Keep | Notes |
|---|---|---|
| Completed Contacts, jobs, sales, callbacks, cancellations and their links | Indefinitely | The business history a JMS needs. Archived, not deleted. |
| Customer record + phone number(s) + external IDs | While the customer relationship is relevant; review annually | Delete or anonymise on a customer's request, keeping the business records with the customer link removed. |
| Call/message events (direction, outcome, staff, times, duration, IDs) | Indefinitely (small) | The message **text** is not copied in bulk — the CRM keeps a link to Podium. |
| Drafts completed or dismissed | Indefinitely, as history | Dismissed drafts keep the reason and who dismissed them. |
| Needs Attention reviews/dismissals | Indefinitely | Audit trail. |
| Advertising attribution | Indefinitely | Identifiers like GCLID have no value after ~90 days for Google but remain evidence. |
| Activity history / Settings Activity | Indefinitely | |
| Raw webhook deliveries | ~30 days | Troubleshooting only. |
| Recordings, voicemail audio, attachments | Never copied | Links only (provider links expire). |
| AI summaries / message excerpts shown in Needs Attention | Only the short summary or first message needed to act; not full transcripts | Full conversation stays in Podium. |

Backups include everything above except raw webhook deliveries. Restoring an
older backup keeps newer integration tables (the same pattern as Settings
Activity).

## 7. Likely costs (none approved)
| Item | Likely cost | Status |
|---|---|---|
| Podium API access | Unknown — not published | Ask Podium |
| Podium plan features (calls API, AI, webchat) | Possibly plan-dependent | Ask Podium |
| AroFlo API | Enabled through AroFlo support; extra cost not published | Already in use; confirm no new charges |
| Google Ads API / Data Manager API | No fees published | Free tier expected; Google Cloud project needed |
| Website changes to capture GCLID/landing page | One-off web developer time | Depends on who manages the site (JET?) |
| Call-tracking provider (e.g. CallRail from ~US$50/month; WhatConverts US$30–160/month; Delacon by quote) | Monthly | **Not recommended** until Podium, Google and JET are known |
| Replacement phone platform (e.g. Aircall from A$45/user/month, min. 3) | Monthly | **Not recommended**; only if Podium proves limiting |
| CRM hosting (Railway) | Small increase for webhooks/storage | Monitor |
| Development time per phase | Per phase | Each phase approved separately |

## 8. Questions to send Podium
See `docs/podium-questions.md` (ready to send).

## 9. Information needed from Kurt, JET, the website and Google
1. **Phone numbers:** every Podium number on the account (08 landline, 04
   mobile, any others), which location each belongs to, and whether any is a
   Google forwarding number or a campaign tracking number.
2. **Google Ads (Kurt):** who owns the account; the customer ID; whether
   auto-tagging is on; whether call assets/forwarding numbers or website call
   tracking are used; which conversion actions exist and their windows; whether
   offline/enhanced conversions are set up; who can grant API access.
3. **JET:** what JET manages (ads, website, SEO, tracking); whether JET uses
   call tracking or tracking numbers; what reports/data JET can share; whether
   JET captures GCLID or UTM on forms; any contract terms about data access.
4. **Website:** who manages it and on what platform; whether Podium webchat is
   on it; what forms exist and where they send enquiries; whether pages keep
   GCLID/UTM in the address; whether the Google tag (gtag/GTM) is installed;
   current privacy policy location and who can change it.
5. **Podium (owners):** plan name; whether AI Employee and webchat are on the
   plan; who the account admin is; whether call recording is on and what
   recording notice callers hear.

## 10. Suggested phases (each needs separate approval)
0. Answers and account checks (this document, Podium questions, §9).
1. Read-only Podium call log on a timer + missed/abandoned reports. No workflow
   change.
2. Needs Attention extensions: missed/abandoned calls, AI and webchat
   enquiries, returned calls, with Create contact (drafts reviewed by staff).
3. Webhooks + live call bubble + one draft per answered inbound call.
4. AroFlo read-only expansion: quotes, status, outcomes; customer and job
   timelines; CRM customer records with AroFlo client links.
5. Google: website capture (after website decisions), GCLID look-ups, cost
   import, advertising report.
6. Later: sending confirmed outcomes to Google (after privacy review);
   provider changes only if needed.

## 11. Database, backup, restore and rollback (all phases)
- Additive tables only (customers, customer_links, communication_events,
  contact_drafts, attribution, provider_user_map, webhook_log). No existing
  record is rewritten.
- Drafts live in their own table and become normal Contacts only when staff
  complete them, so existing reports and older code are unaffected.
- Backups include the new tables except the raw webhook log; restoring an
  older backup keeps the newer integration tables.
- Rollback: the previous code ignores the new tables; webhooks pause and the
  timed import catches up after redeploying. Provider credentials can be
  removed to stop all integration activity immediately.
- Each phase goes through the release checks in `RELEASE_CHECKS.md`, including
  migration on a throwaway copy of the latest backup and a rollback test.
