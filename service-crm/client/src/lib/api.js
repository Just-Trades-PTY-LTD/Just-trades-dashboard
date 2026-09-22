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
    throw new Error(message);
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
    list: () => request('GET', '/users'),
    create: (body) => request('POST', '/users', body),
    update: (id, body) => request('PATCH', `/users/${id}`, body),
  },
  settings: {
    bundle: () => request('GET', '/settings/bundle'),
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
  },
  calls: {
    list: (params) => request('GET', `/calls${qs(params)}`),
    history: (id) => request('GET', `/calls/${id}/history`),
    create: (body) => request('POST', '/calls', body),
    update: (id, body) => request('PATCH', `/calls/${id}`, body),
    archive: (id, archived) => request('PATCH', `/calls/${id}/archive`, { archived }),
    remove: (id) => request('DELETE', `/calls/${id}`),
  },
  tech: {
    entries: (params) => request('GET', `/tech/entries${qs(params)}`),
    history: (kind, id) => request('GET', `/tech/entries/${kind}/${id}/history`),
    createNewJob: (body) => request('POST', '/tech/new-job', body),
    updateNewJob: (id, body) => request('PATCH', `/tech/new-job/${id}`, body),
    createQuoteApprovedLater: (body) => request('POST', '/tech/quote-approved-later', body),
    updateQuoteApprovedLater: (id, body) => request('PATCH', `/tech/quote-approved-later/${id}`, body),
    createCallBack: (body) => request('POST', '/tech/call-backs', body),
    updateCallBack: (id, body) => request('PATCH', `/tech/call-backs/${id}`, body),
    createPendingCancellation: (body) => request('POST', '/tech/pending-cancellations', body),
    updatePendingCancellation: (id, body) => request('PATCH', `/tech/pending-cancellations/${id}`, body),
    archive: (kind, id, archived) => request('PATCH', `/tech/entries/${kind}/${id}/archive`, { archived }),
    remove: (kind, id) => request('DELETE', `/tech/entries/${kind}/${id}`),
  },
  lookup: {
    job: (jn) => request('GET', `/lookup/job${qs({ jn })}`),
    sale: (jn) => request('GET', `/lookup/sale${qs({ jn })}`),
  },
  reports: {
    calls: (params) => request('GET', `/reports/calls${qs(params)}`),
    tech: (params) => request('GET', `/reports/tech${qs(params)}`),
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
