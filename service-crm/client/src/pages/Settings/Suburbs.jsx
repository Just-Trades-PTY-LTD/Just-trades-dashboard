import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function Suburbs({ refreshCount }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ rows: [], total: 0, pageSize: 50 });
  const [bulkText, setBulkText] = useState('');
  const [importResult, setImportResult] = useState(null);

  function reload() {
    api.settings.suburbs({ q: query, page, pageSize: 50 }).then(setResult);
  }

  useEffect(reload, [query, page]);

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));

  async function updateRow(id, field, value) {
    await api.settings.updateSuburb(id, { [field]: value });
    reload();
  }

  async function removeRow(id) {
    await api.settings.removeSuburb(id);
    reload();
    refreshCount();
  }

  async function addRow() {
    await api.settings.addSuburb('New suburb', '');
    reload();
    refreshCount();
  }

  async function importBulk() {
    const res = await api.settings.bulkImportSuburbs(bulkText);
    setImportResult(res);
    setBulkText('');
    reload();
    refreshCount();
  }

  return (
    <div className="panel span-2" style={{ padding: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Suburbs (SA)</div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 12 }}>
        {result.total.toLocaleString()} suburbs currently loaded. Use bulk import below to add more without retyping them here.
      </div>

      <div className="field" style={{ maxWidth: 320, marginBottom: 10 }}>
        <label>Search</label>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder="Filter by name or postcode…"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 8, marginBottom: 6, fontSize: 11, color: 'var(--ink-muted)' }}>
        <div>Suburb</div>
        <div>Postcode</div>
        <div></div>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', marginBottom: 10 }}>
        {result.rows.map((s) => (
          <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 8, marginBottom: 6 }}>
            <input
              defaultValue={s.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && updateRow(s.id, 'name', e.target.value.trim())}
              style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5 }}
            />
            <input
              defaultValue={s.postcode}
              onBlur={(e) => e.target.value !== s.postcode && updateRow(s.id, 'postcode', e.target.value.trim())}
              style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5 }}
            />
            <button className="btn btn-sm btn-danger" onClick={() => removeRow(s.id)} type="button">
              Remove
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <button className="btn" onClick={addRow} type="button">
          Add suburb
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} type="button">
            Prev
          </button>
          Page {page} of {totalPages}
          <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} type="button">
            Next
          </button>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Bulk import</div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
          Required format: one suburb per line, as <span className="mono">Suburb name, Postcode</span> (postcode is 4 digits). Example:{' '}
          <span className="mono">Glenelg, 5045</span>. Duplicates already in the list are skipped automatically.
        </div>
        <textarea rows={5} value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={'Adelaide, 5000\nGlenelg, 5045\nNorwood, 5067'} />
        <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={importBulk} disabled={!bulkText.trim()} type="button">
          Import list
        </button>
        {importResult && (
          <div style={{ marginTop: 10, fontSize: 12.5 }}>
            <div>
              {importResult.added} added, {importResult.skippedDup} skipped (already in the list), {importResult.rejected.length} rejected
              (invalid format).
            </div>
            {importResult.rejected.length > 0 && (
              <div style={{ marginTop: 6, color: 'var(--alert)' }}>
                Rejected lines:
                {importResult.rejected.map((l, i) => (
                  <div key={i} className="mono">
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
