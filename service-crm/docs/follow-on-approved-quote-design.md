# Follow-on approved quotes — design (approved, not built)

Status: design approved 18 Nov 2026. **Not built.** Nothing in the live CRM has
changed, sale #24 has not been edited and JN 2747 has not been entered.

## 1. The situation this covers

A chain of approved work for one customer:

1. **JN 2317** — Tylor's visit, Qualified, no sale → a genuine knockback (job #46).
2. **JN 2373** — the quote was approved later. Recorded as Quote Approved Later
   sale #24 (invoice 2088, $760, 29 Sep 2026). It converts the 2317 knockback
   and stays attributed to the original Google lead. (2373 is only in sale
   #24's comments, because the New Job Number field didn't exist then.)
3. **JN 2747** — while doing 2373, Tylor quoted new work, which was approved
   separately (invoice 2241, $11,623).

Required reporting for 2747 (and any later level of the same kind):

- a normal sale: counts in sales, sales value and average sale;
- reported under the **Repeat customer** Lead Source;
- **never** a Converted Later credit and never offsets or converts any knockback;
- **not** an Upsell.

## 2. Why the CRM can't record it today

- The Original Job Number on a Quote Approved Later entry must match a
  Technician & Sales **job entry** (`findOriginalJob`, jobs table only). 2373 is
  not a job entry, so it is refused — even once 2373 is added as sale #24's
  New Job Number.
- Entering 2747 under Original JN 2317 instead would report it under Google and
  let it act as a Converted Later credit against any other unconverted
  knockback Tylor has in the same Monday–Sunday week. Entering it as an Upsell
  would add the value but not count as a sale. Neither is correct.

## 3. Data change

- One new nullable column: `sales.follows_sale_id` — the id of the approved sale
  **immediately before** this one in the chain.
- Additive migration only. Empty (NULL) on every existing sale, so no existing
  record or report changes. Included in backups; restoring an older backup
  without the column still works.
- A follow-on sale has **no job link** (`job_id` NULL). It still stores and
  shows its own Original Job Number (e.g. 2373) and New Job Number (e.g. 2747).
- The full chain (2317 → 2373 → 2747) is worked out from the links each time
  it is shown, so it can't go stale.

## 4. Entering a follow-on (Existing Job — Quote Approved Later form)

When the Original Job Number has no job entry, the CRM also checks active
(non-Upsell) Quote Approved Later sales' New Job Numbers, including other
follow-ons.

Lookup box when 2373 is typed:

```
Original Job Number *  [ 2373 ]
JN 2373 is the New Job Number of an earlier approved quote:
  Sale #24 · JN 2317 → 2373 · invoice 2088 · $760 · Tylor · 29 Sep 2026
Chain: JN 2317 (knockback, converted later) → JN 2373

[ ] This is new work quoted during JN 2373 and approved separately — record it
    as a follow-on approved quote. It counts as a normal sale under Repeat
    customer, and does not convert a knockback or count as a Converted Later
    credit.
```

- Once ticked, Credited Technician, Trade, Job Type and Suburb prefill from the
  earlier sale (all still editable). New Job Number, invoice, date and value
  are entered as normal; the AroFlo lookup on the New Job Number works as today.
- A "Follow-on approved quote · Repeat customer" label shows above Save.
- Save is blocked with a clear message when:
  - the box isn't ticked ("Confirm this is a follow-on approved quote, or check
    the Original Job Number");
  - the number is on no job entry and no earlier sale ("No job entry or earlier
    approved sale has JN 2373. If 2373 was the New Job Number of an earlier
    approved quote, add it to that sale first.");
  - the New Job Number is already used on another approved quote (existing
    check), or equals the Original Job Number;
  - the earlier sale is archived (only active sales can be followed on from).
- If the number matches **both** a job entry and an earlier sale's New Job
  Number, both are shown and staff must choose. The CRM never chooses. (None
  in the 13 Nov backup.)
- Further levels: typing 2747 later finds the 2747 follow-on sale and offers the
  same tick-box; the new sale links to the 2747 sale (always the one
  immediately before it).

## 5. How a saved follow-on shows

Job History row:

```
JN 2373 │ New JN 2747 │ Existing Job — Quote Approved Later
        │ [Follow-on approved quote] [Repeat customer]
        │ Chain: JN 2317 (knockback) → 2373 (sale #24) → 2747 (this sale)
        │ View previous approved sale →
```

- The "Original knockback job: not linked / Link to original job…" line is
  hidden for follow-ons, so one can't be linked to a job by mistake.
- The earlier sale's row shows "Followed on by: JN 2747 (sale #NN) →".
- Searching Job History for any JN in the chain finds the records that carry it.

## 6. Record history

Written once, permanently, when the follow-on is saved:

- **Follow-on sale:** "Created by [staff] · [Adelaide date/time]. Follow-on
  approved quote of sale #24 (JN 2317 → 2373). Chain at save: JN 2317 → 2373 →
  2747. Original Job Number 2373, New Job Number 2747, invoice 2241, $11,623,
  Credited Technician Tylor."
- **Earlier sale (#24):** "Follow-on approved quote sale #NN (JN 2747, invoice
  2241) linked by [staff] · [date/time]."

The chain wording is stored as it was at the time, so history still reads
correctly if a record is later archived or corrected. Later field edits are
recorded field by field as today. All entries also appear in Settings → Activity.

## 7. Editing rules

- A follow-on's **Original Job Number** isn't edited in the normal edit form; it
  shows the chain instead. Mistakes are fixed with **Correct follow-on link**
  (§8).
- An earlier sale's **New Job Number** can't be changed while a follow-on
  depends on it ("Follow-on sale #NN (JN 2747) depends on New Job Number
  2373."). All its other fields stay editable. To change it, first correct the
  follow-on's link.
- All other fields on a follow-on (technician, trade, job type, invoice, date,
  value, suburb, comments) edit as normal.

## 8. Correct follow-on link (decided 18 Nov 2026)

A **Correct follow-on link…** action on a follow-on sale, for **Admin and Staff**
accounts only. Technician accounts never see it and the server refuses it for
them.

Steps:

1. Staff enter the correct earlier approved Job Number. The CRM finds the
   matching active approved sale by its New Job Number.
2. A confirmation screen shows, side by side:
   - **Current:** previous sale #, its JNs, invoice, value, technician, and the
     current chain;
   - **Proposed:** the replacement sale, the new Original Job Number (= the
     replacement's New Job Number) and the resulting chain — including any
     later follow-ons that hang off this sale and would move with it.
3. A **reason is required** (max 500 characters).
4. Staff confirm. The link and Original Job Number change together in one
   transaction; a refusal changes nothing.

Validation — the correction is blocked if:

- the replacement is the same as the current link (nothing to change);
- the replacement is this sale itself, or any later follow-on of this sale
  (would make the chain circular);
- the replacement is archived, an Upsell, not a Quote Approved Later sale, or
  has no New Job Number;
- the resulting Original Job Number would equal this sale's own New Job Number;
- the reason is blank.

What the correction never does:

- never changes the sale value, invoice, date, technician or any other field;
- never links the sale to a Technician & Sales job, converts a knockback or
  creates a Converted Later credit — it stays a Repeat customer follow-on sale;
- never deletes or rewrites earlier history entries.

History — new entries are **added**; the original entries stay as they were:

- **Corrected sale:** "Follow-on link corrected by [user] · [date/time].
  Reason: … Before: follows sale #A (JN x → y), Original JN y, chain …
  After: follows sale #B (JN p → q), Original JN q, chain …"
- **Previous earlier sale (#A):** "Follow-on sale #NN unlinked by correction
  ([user], [date/time]). Reason: …"
- **New earlier sale (#B):** "Follow-on sale #NN linked by correction
  ([user], [date/time]). Reason: …"
- All three entries also appear in Settings → Activity.

## 9. Archived earlier sale (decided 18 Nov 2026)

- If the earlier approved sale is archived, the follow-on **keeps counting
  normally** under Repeat customer: sale count, value and average sale
  unchanged. It still never creates a Converted Later credit.
- Data Health lists it: **"Follow-on approved quotes whose previous approved
  sale is archived"** (follow-on JN, New JN, invoice, value, previous sale and
  its JN) so Admin or Staff can review it — restore the earlier sale, correct
  the link (§8), or leave it as is.
- Restoring the earlier sale removes it from that list automatically.
- If a follow-on itself is archived, it drops out of reports like any archived
  sale; any follow-ons of it appear in the Data Health list above.

## 10. Reports

| Figure | Follow-on sale |
|---|---|
| Sales count, sales value, average sale | Counted as normal |
| Lead Source / marketing category | Repeat customer |
| Converted Later credit / knockback offset | Never, in any week |
| Knockback conversion (converted later flag) | Never |
| Closing an open follow-up | Never (no job link) |
| Upsell figures | Not an Upsell |

Earlier sales and their jobs are unchanged (sale #24 / job #46 stay Google and
Converted Later for 2317).

## 11. Effect on existing records

- 13 Nov backup check: no existing chains (no sale's Job Number is another
  approved sale's New Job Number, no job has more than one approved-quote
  sale). Sale #24 is the only approved quote with no New Job Number.
- No existing record or historical report changes. Before release this is
  proved with the before/after report comparison, migration and rollback on a
  fresh verified backup copy. Sales entered after 13 Nov are rechecked then.

## 12. Order of steps (when the build is approved)

1. Build on its own branch; test on backup copies; show screenshots and results.
2. After approval: verified backup, release checks against current live, push.
3. Staff add New Job Number 2373 to sale #24 through the normal edit screen
   (no figures change).
4. Staff enter 2747 as a follow-on of sale #24 using the tick-box.

## 13. Still open

- Whether one earlier approved sale may have **more than one** follow-on (two
  separate pieces of new work quoted during the same job). The design allows it
  (each needs its own New Job Number) unless decided otherwise.
