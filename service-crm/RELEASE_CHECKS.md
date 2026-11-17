# Release checks — before anything goes live

Nothing is pushed to the live branch (`claude/just-trades-crm-build-98zros`,
auto-deployed by Railway) until the owner has approved it **and** every check
below passes on the exact commit being pushed.

## 1. Safe for existing data

- The push is a fast-forward of what is live now, containing only the approved change.
- No unapproved database writes: search the diff for `INSERT`, `UPDATE`,
  `DELETE`, `ALTER`, `CREATE TABLE`, `DROP` and `run(`; any schema change or
  backfill needs the owner's explicit approval.
- Existing records are never rewritten, backfilled or "fixed" automatically.
- AroFlo stays read-only: only GET requests.
- No held, unapproved or out-of-scope work is included.

## 2. Safe with real-world data (added 13 Nov 2026)

On 13 Nov a Stage 6 check called `.trim()` on an invoice number. Real AroFlo
sends invoice numbers as numbers, so the Technician & Sales form crashed to a
blank page as soon as AroFlo filled the invoice in. The tests had passed
because the fake AroFlo used text. These checks exist so that can't recur:

- **All tests**, including `messyAroflo.test.js` (every AroFlo lookup fed
  numbers, nested objects and blanks; every value it passes to the screens
  must be the expected type): `npm run crm:test`.
- **Build:** `npm run crm:build`.
- **Browser release check on the latest full backup** (a throwaway copy, with a
  fake AroFlo sending messy data):

  ```
  npm run crm:build
  NODE_PATH=$(npm root -g) node service-crm/scripts/release-check.cjs --backup <latest crm-backup.json>
  ```

  It opens every tab and sub-tab, fills and saves every Technician & Sales
  entry type and every Calls & Contacts call type with real Job Numbers from
  the backup, presses every "Use this", and fails on any blank page,
  "Something went wrong" screen, browser error, server error, or a Job/Invoice
  Number saved as a number or "2180.0". It also renames, hides and shows again
  a list item (checking a hidden item isn't offered on a new call), checks
  Remove is refused for a used item, removes and restores a linked account,
  permanently deletes an unlinked inactive account, and checks Settings
  Activity records it all.
- **Any database change:** migrate a throwaway copy of the latest backup with
  the new code (built with the live code first) and compare every table, Data
  Health and the reports before and after; then open the migrated copy with
  the previous code (rollback) and compare again.
- **Before a live database change:** take a current backup, restore it into a
  temporary copy to prove it's complete, and run the migration and rollback on
  that copy before deploying.
- **Integrations:** each has its own feature switch (off by default) so it can be
  turned off immediately without affecting the rest of the CRM.

## Rules for new code

- Anything from AroFlo goes through `server/src/aroflo/values.js`
  (`asText`, `asTextOrNull`, `asMoney`) before it reaches the browser.
- Anything a lookup puts into a form goes through `textOnly()`
  (`client/src/lib/textFields.js`).
- Never assume a value is a string: use `String(v ?? '')` before `.trim()`,
  `.toLowerCase()`, `.slice()` and similar.
- A new AroFlo lookup is added to `messyAroflo.test.js`; a new form or entry
  type is added to `scripts/release-check.cjs`.
- Any screen error shows "Something went wrong on this screen" (never a blank
  page) and is written to the server log as `[client-error]` — check the
  Railway log after each release.
