# Just Trades — Technician Dashboard

A manager/dispatcher dashboard that pulls job, staff and timesheet data out of
AroFlo and summarizes it per technician: who's on a job right now, jobs
completed/remaining today, overdue jobs, and hours logged today/this week.

- `server/` — Node/Express API that talks to AroFlo and aggregates the data.
- `client/` — React (Vite) frontend that renders the dashboard.

## Quick start (sample data, no AroFlo account needed)

```bash
npm install
cp server/.env.example server/.env
npm run dev
```

This starts the API on `http://localhost:4000` and the dashboard on
`http://localhost:5173`, both against realistic **mock data** (`AROFLO_MODE=mock`
in `server/.env`), so you can see and iterate on the dashboard immediately.

## Connecting real AroFlo data

AroFlo's REST API is disabled by default and gated per account. To go live:

1. **Enable API access.** Raise a support request with AroFlo to enable REST
   API access for your account. They'll issue an **SDK key** for the
   integration.
2. **Generate account keys.** In AroFlo, go to Setup → API Access and generate
   an **Access key** / **Secret key** pair for this integration.
3. **Get the Postman collection.** AroFlo's API reference
   (https://apidocs.aroflo.com) is account-gated and ships a Postman
   collection with a pre-request script showing the exact request-signing
   steps AroFlo expects. Open it once with your account login.
4. **Confirm the client matches.** `server/src/aroflo/liveClient.js` implements
   AroFlo's documented HMAC-SHA256 request signing and the `jobs` / `staff` /
   `timesheets` endpoints. The handful of spots marked `VERIFY:` in that file
   (the exact header names and the canonical string AroFlo signs) should be
   checked against the Postman collection from step 3 and adjusted if they
   differ — everything else (aggregation, the dashboard UI) does not need to
   change.
5. **Set credentials and switch modes.** In `server/.env`:

   ```
   AROFLO_MODE=live
   AROFLO_SDK_KEY=...
   AROFLO_ACCESS_KEY=...
   AROFLO_SECRET_KEY=...
   AROFLO_BASE_URL=https://api.aroflo.com
   ```

   Restart the server — it now pulls live data on the interval set by
   `REFRESH_INTERVAL_MS` (default 60s) and caches it in memory for the
   frontend to poll.

## Project layout

```
server/
  src/
    aroflo/
      liveClient.js   # signed HTTP client for the real AroFlo API
      mockClient.js   # sample-data client, same interface
      index.js        # picks live vs mock based on AROFLO_MODE
    services/
      aggregate.js    # raw AroFlo data -> per-technician dashboard summary
    routes/
      dashboard.js    # GET /api/dashboard, POST /api/dashboard/refresh
    index.js          # Express app entry point
client/
  src/
    components/       # KPI tiles, job status chart, technician table
    App.jsx           # fetches /api/dashboard and polls every 60s
```

## Scripts

Run from the repo root (npm workspaces):

- `npm run dev` — server + client together, with hot reload
- `npm run dev:server` / `npm run dev:client` — either one alone
- `npm run build` — production build of the client
- `npm start` — run the built server (serves the API only; deploy the client
  build behind your own static host/CDN, or add a static-file route to
  `server/src/index.js` if you want one process to serve both)
