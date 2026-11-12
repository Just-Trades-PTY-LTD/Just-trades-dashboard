async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function qs(params = {}) {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!clean.length) return '';
  return `?${new URLSearchParams(clean).toString()}`;
}

export const api = {
  auth: {
    login: (email, password) => request('POST', '/auth/login', { email, password }),
    logout: () => request('POST', '/auth/logout'),
    me: () => request('GET', '/auth/me'),
    changePassword: (currentPassword, newPassword) => request('POST', '/auth/change-password', { currentPassword, newPassword }),
  },
  users: {
    directory: () => request('GET', '/users/directory'),
    // Includes deactivated accounts, for a historical filter (Call History,
    // Reports, admin Activity) — never for a dropdown that assigns new work.
    directoryAll: () => request('GET', '/users/directory?all=1'),
    list: () => request('GET', '/users'),
    create: (body) => request('POST', '/users', body),
    update: (id, body) => request('PATCH', `/users/${id}`, body),
    // Technician access (admin only): preview, change to Technician, back to Staff.
    technicianPreview: (id, technicianId) => request('GET', `/users/${id}/technician-preview${qs({ technicianId })}`),
    linkTechnician: (id, technicianId) => request('POST', `/users/${id}/technician-link`, { technicianId, confirm: true }),
    unlinkTechnician: (id) => request('POST', `/users/${id}/technician-unlink`, { confirm: true }),
  },
  // Technician accounts only — always scoped by the server to the linked technician.
  me: {
    reportSettings: () => request('GET', '/me/report-settings'),
    teamReport: (params) => request('GET', `/me/team-report${qs(params)}`),
    teamKnockbackReasons: (params) => request('GET', `/me/team-knockback-reasons${qs(params)}`),
    performanceDrilldown: (params) => request('GET', `/me/performance/drilldown${qs(params)}`),
    reviews: (params) => request('GET', `/me/reviews${qs(params)}`),
  },
  settings: {
    bundle: () => request('GET', '/settings/bundle'),
    arofloTaskTypeMappings: () => request('GET', '/settings/aroflo-task-type-mappings'),
    saveArofloTaskTypeMappings: (mappings) => request('PUT', '/settings/aroflo-task-type-mappings', { mappings }),
    arofloLeadSourceMappings: () => request('GET', '/settings/aroflo-lead-source-mappings'),
    saveArofloLeadSourceMappings: (mappings) => request('PUT', '/settings/aroflo-lead-source-mappings', { mappings }),
    addTrade: (name) => request('POST', '/settings/trades', { name }),
    updateTrade: (id, name) => request('PATCH', `/settings/trades/${id}`, { name }),
    removeTrade: (id) => request('DELETE', `/settings/trades/${id}`),
    addJobType: (tradeId, name) => request('POST', `/settings/trades/${tradeId}/job-types`, { name }),
    updateJobType: (id, name) => request('PATCH', `/settings/job-types/${id}`, { name }),
    removeJobType: (id) => request('DELETE', `/settings/job-types/${id}`),
    addTechnician: (name) => request('POST', '/settings/technicians', { name }),
    updateTechnician: (id, body) => request('PATCH', `/settings/technicians/${id}`, body),
    removeTechnician: (id) => request('DELETE', `/settings/technicians/${id}`),
    addListItem: (category, name) => request('POST', `/settings/lists/${category}`, { name }),
    updateListItem: (id, name) => request('PATCH', `/settings/list-items/${id}`, { name }),
    removeListItem: (id) => request('DELETE', `/settings/list-items/${id}`),
    suburbs: (params) => request('GET', `/settings/suburbs${qs(params)}`),
    searchSuburbs: (q) => request('GET', `/settings/suburbs/search${qs({ q })}`),
    addSuburb: (name, postcode) => request('POST', '/settings/suburbs', { name, postcode }),
    updateSuburb: (id, body) => request('PATCH', `/settings/suburbs/${id}`, body),
    removeSuburb: (id) => request('DELETE', `/settings/suburbs/${id}`),
    bulkImportSuburbs: (text) => request('POST', '/settings/suburbs/bulk-import', { text }),
    updateFollowUpDefaultDueDays: (days) => request('PATCH', '/settings/follow-up-default-due-days', { days }),
  },
  calls: {
    list: (params) => request('GET', `/calls${qs(params)}`),
    history: (id) => request('GET', `/calls/${id}/history`),
    create: (body) => request('POST', '/calls', body),
    update: (id, body) => request('PATCH', `/calls/${id}`, body),
    remove: (id) => request('DELETE', `/calls/${id}`),
    exportXlsxUrl: (params) => `/api/calls/export.xlsx${qs(params)}`,
  },
  tech: {
    entries: (params) => request('GET', `/tech/entries${qs(params)}`),
    entriesXlsxUrl: (params) => `/api/tech/entries/export.xlsx${qs(params)}`,
    history: (kind, id) => request('GET', `/tech/entries/${kind}/${id}/history`),
    createNewJob: (body) => request('POST', '/tech/new-job', body),
    updateNewJob: (id, body) => request('PATCH', `/tech/new-job/${id}`, body),
    createQuoteApprovedLater: (body) => request('POST', '/tech/quote-approved-later', body),
    updateQuoteApprovedLater: (id, body) => request('PATCH', `/tech/quote-approved-later/${id}`, body),
    createUpsell: (body) => request('POST', '/tech/existing-job-upsell', body),
    updateUpsell: (id, body) => request('PATCH', `/tech/existing-job-upsell/${id}`, body),
    createCallBack: (body) => request('POST', '/tech/call-backs', body),
    updateCallBack: (id, body) => request('PATCH', `/tech/call-backs/${id}`, body),
    createPendingCancellation: (body) => request('POST', '/tech/pending-cancellations', body),
    updatePendingCancellation: (id, body) => request('PATCH', `/tech/pending-cancellations/${id}`, body),
    remove: (kind, id) => request('DELETE', `/tech/entries/${kind}/${id}`),
  },
  // Admin-only. Always preview first (it changes nothing), show the admin what
  // will change, then apply with the preview's token — the server refuses if
  // the records changed in between.
  archive: {
    preview: (items, archived) => request('POST', '/archive/preview', { items, archived }),
    apply: (items, archived, token) => request('POST', '/archive/apply', { items, archived, token }),
    linkQalPreview: (saleId) => request('POST', '/archive/link-qal/preview', { saleId }),
    linkQalApply: (saleId, token) => request('POST', '/archive/link-qal/apply', { saleId, token }),
    knockbackFlagPreview: (jobId) => request('POST', '/archive/knockback-flag/preview', { jobId }),
    knockbackFlagApply: (jobId, token) => request('POST', '/archive/knockback-flag/apply', { jobId, token }),
  },
  followUps: {
    list: (params) => request('GET', `/follow-ups${qs(params)}`),
    get: (id) => request('GET', `/follow-ups/${id}`),
    defaultDueDate: (attendanceDate) => request('GET', `/follow-ups/default-due-date${qs({ attendanceDate })}`),
    create: (body) => request('POST', '/follow-ups', body),
    addNote: (id, note) => request('POST', `/follow-ups/${id}/notes`, { note }),
    updateDueDate: (id, dueDate, note) => request('PATCH', `/follow-ups/${id}/due-date`, { dueDate, note }),
    close: (id, outcome, note) => request('PATCH', `/follow-ups/${id}/close`, { outcome, note }),
    reopen: (id, note) => request('PATCH', `/follow-ups/${id}/reopen`, { note }),
  },
  reviews: {
    list: (params) => request('GET', `/reviews${qs(params)}`),
    create: (body) => request('POST', '/reviews', body),
    update: (id, body) => request('PATCH', `/reviews/${id}`, body),
  },
  lookup: {
    job: (jn) => request('GET', `/lookup/job${qs({ jn })}`),
    sale: (jn) => request('GET', `/lookup/sale${qs({ jn })}`),
    call: (jn) => request('GET', `/lookup/call${qs({ jn })}`),
    callbackOrigin: (jn) => request('GET', `/lookup/callback-origin${qs({ jn })}`),
  },
  reports: {
    calls: (params) => request('GET', `/reports/calls${qs(params)}`),
    tech: (params) => request('GET', `/reports/tech${qs(params)}`),
    knockbackReasons: (params) => request('GET', `/reports/tech/knockback-reasons${qs(params)}`),
    reviews: (params) => request('GET', `/reports/reviews${qs(params)}`),
    callsXlsxUrl: (params) => `/api/reports/calls.xlsx${qs(params)}`,
    techXlsxUrl: (params) => `/api/reports/tech.xlsx${qs(params)}`,
    reviewsXlsxUrl: (params) => `/api/reports/reviews.xlsx${qs(params)}`,
    callsDrilldown: (params) => request('GET', `/reports/calls/drilldown${qs(params)}`),
    techDrilldown: (params) => request('GET', `/reports/tech/drilldown${qs(params)}`),
    reviewsDrilldown: (params) => request('GET', `/reports/reviews/drilldown${qs(params)}`),
    getLayouts: () => request('GET', '/reports/layouts'),
    saveLayout: (reportKey, layout) => request('PUT', `/reports/layouts/${reportKey}`, { layout }),
  },
  audit: {
    activity: (params) => request('GET', `/audit/activity${qs(params)}`),
  },
  dataHealth: {
    run: () => request('GET', '/data-health'),
  },
  arofloTest: {
    lookup: (jn) => request('GET', `/aroflo-test/lookup${qs({ jn })}`),
    taskTypes: () => request('GET', '/aroflo-test/task-types'),
    locations: () => request('GET', '/aroflo-test/locations'),
    users: () => request('GET', '/aroflo-test/users'),
    customerHistory: (jn) => request('GET', `/aroflo-test/customer-history${qs({ jn })}`),
    suburbCheck: (count) => request('GET', `/aroflo-test/suburb-check${qs({ count })}`),
    taskTypesAll: () => request('GET', '/aroflo-test/task-types-all'),
    leadSourceOptions: () => request('GET', '/aroflo-test/lead-source-options'),
  },
  aroflo: {
    // The real New Job form's lookup — a clean summary, not the admin-only
    // test page's raw data. Always resolves (never throws): a problem of any
    // kind comes back as { found: false, message }, never an HTTP error, so
    // it never blocks manual entry.
    lookup: (jn, { activity } = {}) => request('GET', `/aroflo/lookup${qs({ jn, activity: activity ? 1 : undefined })}`),
    // Calls & Contacts: the automatic Repeat customer check (read-only).
    leadHistory: (jn, excludeCallId) => request('GET', `/aroflo/lead-history${qs({ jn, excludeCallId })}`),
    // Calls & Contacts Pending Cancellation: the Job Number's invoices (read-only).
    pendingCancellationInvoices: (jn, pendingCancellationId) => request('GET', `/aroflo/pending-cancellation-invoices${qs({ jn, pendingCancellationId })}`),
  },
  export: {
    callsCsvUrl: () => '/api/export/calls.csv',
    techCsvUrl: () => '/api/export/tech-entries.csv',
    backupUrl: () => '/api/export/backup.json',
    restore: (backup) => request('POST', '/export/restore', backup),
    clearCalls: () => request('POST', '/export/clear-calls'),
    clearTechData: () => request('POST', '/export/clear-tech-data'),
    autoBackups: () => request('GET', '/export/auto-backups'),
    autoBackupUrl: (filename) => `/api/export/auto-backups/${encodeURIComponent(filename)}`,
  },
};
