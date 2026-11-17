# CRM integration plan (current)

Status: **plan only — nothing built, connected or created.** Each stage below
needs the owner's separate approval before any work starts. This plan
supersedes the direction in `integration-investigation.md` where they differ;
that document still holds the detailed provider research (16 Nov 2026).

Last updated: 17 Nov 2026 (test CRM removed from the plan the same day).

## 1. Direction (confirmed 17 Nov 2026)

- **The full JMS idea and replacing AroFlo are on hold.**
- **AroFlo remains the job management system** — the source of truth for jobs,
  scheduling, technician assignment, quotes, invoices, payments and customer
  details (email, service address, sites).
- **The CRM is the central tracking and reporting hub** for enquiries, sales,
  technician performance and marketing.
- Podium (or a future phone platform) remains the source for calls, texts,
  voicemail, recordings and Podium AI conversations.
- Google Ads remains the source for advertising spend, campaigns and clicks.
- Goals: easier access to information across platforms, less manual entry,
  better lead tracking, and Google Ads enquiries properly connected to
  bookings, jobs, sales and ex-GST revenue.

## 2. Standing rules

- The Podium missed-call text service and all current Just Trades customer
  wording stay unchanged. No automatic messages are activated without
  separate approval.
- **Nothing is written to AroFlo** — not Lead Source, enquiry outcomes or
  anything else — at this stage. AroFlo access stays GET-only.
- Integrations read information and create drafts or Needs Attention items for
  staff to act on. Staff make the judgement calls.
- Nothing is guessed. Uncertain matches and attributions are shown as
  possibilities for staff to choose, never recorded as fact.
- **No call tracking is purchased** until it's confirmed what JET, Google Ads
  and Podium already provide. No other provider purchases are approved.
- ServiceTitan is only a reference for the kind of features; nothing of its
  branding, wording, design or processes is copied.
- Every stage follows the development and release process in §8 and is
  pushed live only with approval.

## 3. Source of truth

| Information | Source of truth | CRM's role |
|---|---|---|
| Jobs, scheduling, technician assignment, quotes, invoices, payments | AroFlo | Reads automatically; links to enquiries; flags mismatches; reports |
| Customer email and service address(es) | AroFlo | Displayed when read from AroFlo, to Admin and office Staff only; never edited or overwritten by the CRM |
| Customer phone number(s) | AroFlo / Podium | Stored encrypted in the CRM for matching and history (§6) |
| Calls, texts, voicemail, recordings, AI conversations | Podium | Logs call/message events with outcome, staff, time, duration and a link back to Podium; recordings stay in Podium |
| Ad spend, campaigns, keywords, click details | Google Ads | Imports cost and click details; never edits ads |
| Website enquiries | The website form / webchat | Recorded in the CRM with their advertising details (once the website is known) |
| **Lead Source and enquiry outcomes** (call type, lead status, booked/not booked, reasons, cancellations) | **CRM** | Staff decide; integrations only suggest. Not written to AroFlo |
| Technician outcomes (qualified, knockbacks, inspection sheets, sale credit) | CRM (Technician & Sales) | Prefilled from AroFlo where possible |
| Sale amounts | AroFlo invoice | The CRM sale keeps the technician credit; differences are flagged for staff review — **neither value is ever overwritten automatically** |
| Marketing attribution, Needs Attention, follow-ups, reviews, reporting | CRM | |

## 4. Decisions recorded

### 17 Nov 2026
1. **Completed AroFlo visits with no Technician & Sales entry** are flagged,
   with a prefilled entry for staff to complete (staff add the outcome).
2. **AroFlo invoice vs CRM sale amount differences** are flagged for staff
   review; neither value is changed automatically.
3. **Lead Source and enquiry outcomes**: the CRM is the source of truth; not
   written to AroFlo at this stage.
4. **No permanent test CRM.** (Approved earlier the same day, then withdrawn by
   the owner.) Changes are tested on the backup branch with temporary database
   copies and mock integration data instead (§8). If an integration genuinely
   can't be tested safely without a separate Railway environment, the reason and
   expected cost are explained first and the owner decides then.
11. **Recent enquiry window: 14 days** (§5.1 step 3).
12. **Railway plan: Pro.**
5. **Call tracking**: not purchased; first confirm what JET, Google Ads and
   Podium already provide.
6. **Outgoing calls**: logged and linked automatically; no draft Contact unless
   a staff member chooses to create one.
7. **Customer email and service addresses**: may be displayed when read from
   AroFlo, permission-controlled; AroFlo stays the source of truth and the CRM
   never overwrites them.
8. **Customer data protection**: use appropriate encryption and access
   controls — recommended approach in §6.
9. **Claiming calls**: if Podium identifies the staff member who answered, the
   call is assigned to them; no separate "I'll take this" step unless a
   specific situation needs it to prevent duplicate handling (§5.3).
10. **Drafts only when genuinely needed** — an answered call is first checked
    against existing contacts, customers, open drafts/Needs Attention items
    and recent activity; see §5.

### 16 Nov 2026 (still in force)
- Customer phone numbers stored securely; Admin and office Staff only, never
  Technician accounts; included in backups.
- Confident match = exact phone match to **one** AroFlo client or **one**
  Podium contact; otherwise staff choose; never match on name alone.
- The draft belongs to the staff member who finishes the call; the history
  records who answered and transfers where Podium provides them.
- Spam / wrong numbers / non-enquiries are completed as Not Qualified / not a
  lead with a comment.
- Podium AI enquiries are a separate group awaiting human follow-up; no
  completed Contact until Jade or Kurt confirms the outcome.
- No number is treated as a Google/tracking number until confirmed.
- The call bubble is for Admin and office Staff only, never Technician
  accounts.
- Retention as in `integration-investigation.md` §6.3 (raw webhook data ~30
  days; recordings never copied).
- AroFlo client IDs may be stored as internal identifiers.

## 5. Calls: matching before creating drafts

### 5.1 Every answered inbound call (when the Podium stages are approved)
Checks run in this order; the first that applies decides what happens. Matches
use the exact phone number only.

1. **Already processed** (same Podium call ID) → nothing new. This also covers
   webhook retries, transfers reported twice and several staff logged in.
2. **Open draft or open Needs Attention item for the same caller** (e.g. a
   missed call, an AI/webchat enquiry, an uncompleted draft) → the call is
   **added to that item**; no new draft. A returned missed call is marked
   "Returned / answered".
3. **Recent enquiry or job for the same caller** — a Contact or call in the last
   **14 days** (approved) or an AroFlo job that isn't completed →
   the call is **linked to that customer and enquiry** on the timeline, and a
   small Needs Attention item asks staff "Link to existing enquiry" (default)
   or "Create new contact" (a genuinely new job). No draft unless staff choose.
4. **Exactly one existing customer** (one CRM customer or one AroFlo client) with
   no recent enquiry → **one new draft**, already linked to that customer
   (e.g. a repeat customer with a new job).
5. **Several possible customers**, or AroFlo and Podium disagree → a Needs
   Attention item "Choose the customer" with safe details for each option; no
   draft until a staff member chooses.
6. **No match** → **one new draft** for staff to review.

Spam and wrong numbers still get completed as Not Qualified / not a lead with a
comment when a draft exists.

### 5.2 Outgoing calls
Logged automatically and linked to the customer (exact phone match) and to any
open item from 5.1 (marked "Returned by <staff>"). Never a draft unless a
staff member chooses **Create contact**.

### 5.3 Assigning a call
- When Podium reports the staff member who handled the call, the call and any
  draft are assigned to them; everyone sees "Answered by …".
- No "I'll take this" step. The one situation where a claim may help — two
  office staff both returning the same **missed** call — is covered by marking
  the Needs Attention item "Being returned by <staff>" as soon as someone
  presses **Call back / Returning this**; this is only added if needed.
- Needs Podium to confirm whether its staff field is the person who answered
  or the person who finished the call.

### 5.4 Messages, webchat and AI enquiries
No message becomes a Contact automatically. Webchat and after-hours AI
enquiries appear in Needs Attention with the customer details, time received,
messages (and Podium's summary if the API provides it) and **Create contact**
(prefilled draft). The same matching (5.1 steps 2–5) is used so a repeat
enquiry joins the existing item rather than creating another.

## 6. Customer data protection (recommended approach)

For the current CRM (one server, SQLite database on a Railway volume, JSON
backups):

1. **Field-level encryption** of customer phone numbers and any cached email or
   service address, using AES-256-GCM. The encryption key is held only in a
   Railway variable (never in the database, code, logs or backups), with a
   second copy stored safely by the owners (e.g. their password manager).
2. **Matching without decrypting**: each phone number also gets a keyed
   one-way fingerprint (HMAC-SHA-256 of the normalised +61 number), so exact
   matching never needs the readable number.
3. **Emails and service addresses are not stored permanently.** They are read
   from AroFlo when an authorised staff member opens a customer, shown, and
   cached (encrypted) only briefly. AroFlo stays the source of truth, nothing
   goes stale, and less personal data sits in the CRM and its backups.
4. **Server-side permissions**: decrypted values are only ever included in
   responses to Admin and office Staff accounts; Technician accounts' routes
   never include them (enforced on the server, not just hidden on screen).
5. **Backups** contain the encrypted values. A backup can't reveal phone numbers
   without the key; restoring needs the same key. A key-change (rotation)
   procedure is documented before go-live.
6. **Audit**: bulk views or exports of customer contact details are recorded in
   Activity history; settings and permission changes already are.
7. Already in place: HTTPS, signed-in sessions, permission checks on every
   route, provider secrets only in server settings, AroFlo GET-only.

## 7. Staged implementation plan

| Stage | What | Depends on |
|---|---|---|
| **0. Preparation** (no code) | Answers below; Podium questions sent; information from Kurt/JET/website/Google | Owner |
| **1. Needs Attention (Stage 4)** | The approved design (`stage4-needs-attention-design.md`, decisions §11), built so later items plug in | "Office Staff" definition; build approval |
| **2. Customer foundation** | CRM customer records linked to AroFlo client IDs; encrypted phone numbers + fingerprints; permission-controlled display of AroFlo email/address; no new outside data yet beyond AroFlo reads | Stage 1; "office Staff" definition |
| **3. AroFlo read-only expansion** | Completed visits without a Technician & Sales entry (prefilled entry); invoice vs sale amount differences; job/quote/invoice status on the timeline; checks every 10–15 minutes | Stage 2; AroFlo `/v2` limits and a read-only API user confirmed |
| **4. Podium call log** | Read-only import on a timer; missed/abandoned reports (time of day, day of week, number called, totals); outgoing calls logged and linked | Podium API access and `read_phones` confirmed |
| **5. Podium live** | Notifications; matching rules (§5); drafts only when needed; call bubble; AI/webchat enquiries in Needs Attention | Stage 4; Podium answers on timing, staff field, transfers |
| **6. Website enquiries** | Enquiries into the CRM with GCLID/GBRAID/WBRAID, UTM and landing page | Website platform and where enquiries go; who can change the site |
| **7. Google Ads** | Click-ID look-ups (campaign, ad group, ad, keyword); cost import; advertising report: cost vs booked leads, qualified leads, sales and ex-GST revenue | Kurt: account, auto-tagging, API access; JET information |
| **8. Optional** | Send confirmed bookings/sales (ex-GST) back to Google | Privacy notice updated; separate approval |

Each stage follows §8: backup branch → temporary database copies and mock
integration data → owner review of the finished feature and test results →
live only with approval.

## 8. Development and release process (no permanent test CRM)

The owner decided on 17 Nov 2026 **not** to create a permanent test or dummy
CRM. (It was mainly considered for the JMS idea, now on hold.) Instead:

1. **Build on the backup branch** (`claude/loving-tesla-770enf`), each change
   on its own short branch merged into it. Railway never deploys these
   branches.
2. **Test with temporary copies of the CRM database**, restored from the
   latest backup on the development machine and thrown away afterwards. Never
   the live database.
3. **Mock or test integration data first**: fake AroFlo, Podium and Google
   responses (including messy real-world data) before any live account is
   connected. When live accounts are connected, read-only access first.
4. **Feature switches**: each integration (AroFlo expansion, Podium, website
   enquiries, Google Ads) has its own on/off switch in server settings, off by
   default. Switching one off stops it immediately without affecting the rest
   of the CRM or any saved records.
5. **Show the owner the completed feature and the test results**
   (screenshots, figures, checks) before anything goes live.
6. **Check each release against the current live version** before deploying: a
   straight step on from live, only the approved change, the full test suite,
   the build, the messy-data tests and the browser release check
   (`RELEASE_CHECKS.md`).
7. **Take and verify a current backup before each live database change
   (migration)**: download it, restore it into a temporary copy, and confirm
   the migration and its rollback on that copy before deploying.
8. **Separate Railway environment only by exception**: if an AroFlo, Podium or
   Google integration genuinely can't be tested safely without one (for
   example, a provider that can only send webhooks to a public address), the
   reason and the expected cost are explained first and the owner decides. For
   reference, Railway's published rates (17 Nov 2026) put a small copy of this
   CRM at about US$2–4/month of usage; the account is on the Pro plan, whose
   monthly fee includes US$20 of usage.

## 9. Still needed from the owner
1. Website platform, and where website enquiries currently go.
2. Who counts as "office Staff" (all Staff accounts, or some excluded).
3. From Kurt / JET / Google / Podium: as listed in
   `integration-investigation.md` §9 and `podium-questions.md`.
