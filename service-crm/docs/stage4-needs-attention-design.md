# Stage 4 — Needs Attention page: design (for approval, not built)

Status: **design approved (decisions recorded 17 Nov 2026, §11) — not built.**
Nothing is built. This first version uses only data
the CRM already has — no Podium, Google or expanded AroFlo data. It is built so
those can be added later as new item sources without rebuilding the page.

## 1. What it is
A page listing records that need a staff action, each linking straight to the
record to fix. It never changes, fixes or dismisses anything by itself; an item
disappears when the underlying record is fixed (and, only if approved, when an
Admin marks it reviewed — §6).

## 2. Proposed rules (first version)
Counts are what each rule would show today on a copy of the 13 Nov backup.

| # | Item | Shows after | Links to | Today |
|---|---|---|---|---|
| 1 | Booked Lead call with no Job Number | Straight away (decided) | The call (Calls & Contacts) | 2 (calls 72, 182) |
| 2 | Job or sale with no Job Number | Straight away | The job/sale (Technician & Sales) | 2 (job 24, sale 14) |
| 3 | Job reporting as Unassigned (no booked Lead call or Call back call for its Job Number) | Straight away, jobs from 1 Oct 2026 onwards (decided) | The job | 4 (2412, 2475, 2621, 2646) |
| 4 | Booked Lead call with a Job Number but no Technician & Sales job, no sale and no Cancellation call | 14 days | The call | **43** (10 Sep, 33 Oct) — see §3 |
| 5 | Sale Made mismatch (same check as Data Health) | Straight away | The job and sale | 1 (2269, Sep) |
| 6 | Pending Cancellation without invoice or lost value | 2 days | The Pending Cancellation's call | 3 (2498, 2683, 2576) |
| 7 | Call Back entry without the new callback Job Number | 7 days | The Call Back entry | 3 (2321, 2408, 2430) |
| 8 | Job with a blank suburb | Straight away, jobs from 1 Oct 2026 onwards (decided) | The job | 1 (2412) |
| 9 | Overdue follow-ups | Count only | The Follow-ups page | 4 |

"Shows after" counts from the call date, visit date or date logged. All
checks ignore archived records and superseded Pending Cancellations.

## 3. Rule 4 finding — needs a decision
43 booked Lead calls (Job Numbers given 14+ days ago) have no Technician &
Sales entry, sale, Call Back entry or Cancellation call at all. Likely causes:
the visit hasn't been logged in Technician & Sales yet; the job was cancelled
without a Cancellation call; or the Job Number on the call differs from the
one used on the job. These affect conversion and marketing reports, so the
rule is worth keeping — but at launch it would be the largest group.

## 4. Who sees it (needs a decision)
Recommended:
- **Admin and office Staff** see every item, with a **"Mine"** filter (items on
  calls they handled or records they created) and an **"All"** view.
- **Technician accounts never see it** (blocked on the server, like the rest of
  the office modules).
- A count on the Home page and next to the tab name.

## 5. Page design
- Grouped by rule, each group with its count, newest-first inside the group.
- Each item: what's wrong in plain words, Job Number, date, age ("6 days"),
  staff member, and a button that opens the record (e.g. "Open call to add Job
  Number"). Customer phone numbers, emails and addresses are not shown.
- Filters: Mine / All, group, age.
- Read-only: worked out live from existing records each time the page opens —
  nothing is stored and nothing is changed. Opening an item uses the existing
  edit screens, so every fix goes through the normal validation and Activity
  history.

## 6. Dismissing (needs a decision)
- **Option A (recommended for the first version): no dismissing.** Items only
  disappear when the record is fixed. No database change at all.
- **Option B:** an Admin can mark an item "Reviewed — leave as is" with a
  reason. Needs one small additive table (item key, reason, who, when),
  recorded in Settings Activity, kept in backups. A reviewed item reappears if
  its record later changes in a way that matters (e.g. the Job Number is
  removed again).

## 7. Older records (needs a decision)
Rules 3 and 8 (and optionally 1 and 4) can start from **1 October** so the
known September history (41 jobs without a Lead call, 40 blank suburbs) doesn't
crowd the page — recommended — or include everything. September items stay
visible in Data Health either way.

## 8. Built to extend later (no integration in this version)
- Each rule is an **item source** on the server returning items in one common
  shape: `{ source, itemKey, group, title, details, recordLinks, date, ageDays,
  ownerUserId, actions }`. The page only knows this shape.
- `itemKey` is stable (e.g. `call:72:no-job-number`), so later a dismissal
  (Option B), a "claimed by" or a "returned by" status can attach to an item.
- `actions` per item lets later sources add buttons such as **Create contact**
  (prefilled draft), **Mark returned**, **No contact needed**.
- Later sources (each separately approved): missed and abandoned calls,
  after-hours Podium AI enquiries, webchat enquiries, draft Contacts needing
  completion, returned missed calls, integration problems (e.g. webhook
  delivery stopped, AroFlo unreachable, an unmatched Podium user).
- Integration items will carry the same permission rules (Admin and office
  Staff only).

## 9. Safety
- No database change for Option A; Option B adds one table (additive, backed
  up, kept when restoring an older backup, ignored by the previous code on
  rollback).
- Read-only queries; nothing written, nothing sent, no AroFlo calls.
- Tests: each rule against known records; permission tests (Technician
  blocked); counts checked against this document on the latest backup copy;
  browser release check extended with the page.

## 10. Decisions needed
1. Who sees it — Admin and office Staff with Mine/All (recommended)?
2. Timings — 1 day / straight away / 14 days / 2 days / 7 days as above?
3. Rule 4 — keep at 14 days (43 items today), or another period?
4. Dismissing — Option A (recommended) or B?
5. Older records — rules 3 and 8 from 1 October (recommended), or everything?

## 11. Decisions (owner, 17 Nov 2026)

1. **Access — Option A.** Admin and office Staff see all Needs Attention items,
   with a **Mine / All** filter. Technician accounts cannot access the page
   (blocked on the server). *Depends on the owner's definition of "office
   Staff" (still to be confirmed); until then this means Admin and Staff
   accounts.*
2. **Waiting times** — as proposed in §2, except **Booked Lead call with no Job
   Number appears straight away** (not after one day). Final timings:
   - Booked Lead call with no Job Number: straight away.
   - Job or sale with no Job Number: straight away.
   - Job reporting as Unassigned: straight away.
   - Sale Made mismatch: straight away.
   - Pending Cancellation without invoice or lost value: after 2 days.
   - Call Back entry without the new callback Job Number: after 7 days.
   - Job with a blank suburb: straight away.
   - Overdue follow-ups: count only, linking to Follow-ups.
3. **Booked Lead with no job entry** — flagged after **14 days** when the call has
   a Job Number but there is no Technician & Sales entry, sale or cancellation
   for it.
4. **Dismissal** — both **Admin and office Staff** can mark an item **"Reviewed —
   leave as is"**. A **reason is required**, and the dismissal is **recorded**
   (who, when, reason). This replaces Option A in §6 with a version of
   Option B open to office Staff, and needs one small additive table (item key,
   reason, who, when), included in backups, kept when restoring an older
   backup, and ignored by the previous code on rollback.
5. **Older records — Option A.** The checks for jobs with no matching booked
   Lead / Call back call (rule 3) and jobs with no suburb (rule 8) only include
   records from **1 October 2026** onwards. September records stay visible in
   Data Health. (Rules 1, 2, 4, 5, 6 and 7 cover all dates.)

### Proposed details for the dismissal (to confirm when Stage 4 is reviewed)
- A dismissed item **reappears automatically** if its record later changes in a
  way that matters to that rule (for example the Job Number is removed again).
- A **"Reviewed" list** shows dismissed items with their reason, who and when;
  an Admin can **reopen** one if it was dismissed by mistake (also recorded).
- Dismissals and reopenings appear in Activity history.
