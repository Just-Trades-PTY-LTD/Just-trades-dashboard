import { useEffect, useRef, useState } from 'react';
import { nextLookupFill } from '../../lib/lookupFill.js';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { nowLocalDateTime } from '../../lib/dates.js';
import { CONTACT_METHOD_OPTIONS } from '../../lib/contactMethods.js';
import { DateTimeField, SelectField, TextAreaField, Checkbox } from '../../components/Fields.jsx';
import { SuburbPicker } from '../../components/SuburbPicker.jsx';
import { JobLookupBox } from '../../components/JobLookupBox.jsx';
import { useJobLookup } from '../../lib/useLookup.js';
import { callLookupSummary, leadSourceDecision } from '../../lib/arofloCallSuggest.js';

const CALL_TYPES = ['Lead', 'Not lead', 'Quote approved', 'Call back', 'Cancellation'];
const CANCELLATION_TYPES = ['New Job Cancellation', 'Pending Cancellation'];

function emptyForm(defaultHandledByUserId) {
  return {
    callAt: nowLocalDateTime(),
    // Contact Method and Call Type both start blank ("—") and must be
    // chosen before saving — see the mandatory-field check in
    // handleSubmit(). Handled by/Date & time keep auto-populating below.
    direction: '',
    handledByUserId: defaultHandledByUserId || '',
    callType: '',
    tradeId: '',
    jobTypeId: '',
    leadSourceId: '',
    booked: '',
    notBookedReasonId: '',
    cancellationType: '',
    cancellationReasonId: '',
    callBackReasonId: '',
    jobNumber: '',
    suburb: '',
    notes: '',
    followUp: false,
  };
}

export default function LogCall({ editing, onSaved, onCancelEdit, setNotice }) {
  const { user } = useAuth();
  const settings = useSettings();
  const [form, setForm] = useState(emptyForm(user?.id));
  const [invalidFields, setInvalidFields] = useState(new Set());
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // Lead calls only: "Look up in AroFlo" (read-only) for this Job Number —
  // e.g. once the job has been booked in AroFlo. Shows why nothing was found,
  // or AroFlo's task type and the customer's Lead Source with a "Use this"
  // suggestion where exactly one of this CRM's options matches by name (see
  // lib/arofloCallSuggest.js). Nothing is applied until staff click "Use
  // this", and nothing is saved until they save the call. `jn` is kept so a
  // result is only shown while the Job Number still matches it.
  const [arofloResult, setArofloResult] = useState(null);
  const [arofloLoading, setArofloLoading] = useState(false);
  // The automatic customer-history (Repeat customer) check, run straight
  // after a successful lookup on a Lead call — separately, so the normal
  // lookup's results show first. { jn, status: 'checking'|'done', result }.
  const [history, setHistory] = useState(null);
  const historySeq = useRef(0);

  useEffect(() => {
    setInvalidFields(new Set());
    setArofloResult(null);
    historySeq.current += 1;
    setHistory(null);
    if (editing) {
      setForm({
        callAt: editing.callAt,
        direction: editing.direction,
        handledByUserId: editing.handledByUserId || '',
        callType: editing.callType,
        tradeId: editing.tradeId || '',
        jobTypeId: editing.jobTypeId || '',
        leadSourceId: editing.leadSourceId || '',
        booked: editing.booked || '',
        notBookedReasonId: editing.notBookedReasonId || '',
        cancellationType: editing.cancellationType || '',
        cancellationReasonId: editing.cancellationReasonId || '',
        callBackReasonId: editing.callBackReasonId || '',
        jobNumber: editing.jobNumber || '',
        suburb: editing.suburb || '',
        notes: editing.notes || '',
        followUp: editing.followUp || false,
      });
    } else {
      // Handled by defaults to whoever's logged in — still a normal editable
      // select, in case one person is logging a call for a colleague.
      setForm(emptyForm(user?.id));
    }
  }, [editing, user]);

  function patch(p) {
    setForm((f) => ({ ...f, ...p }));
  }

  function resetForm() {
    setForm(emptyForm(user?.id));
    setArofloResult(null);
    historySeq.current += 1;
    setHistory(null);
  }

  async function runCustomerHistory(jn) {
    const seq = ++historySeq.current;
    setHistory({ jn, status: 'checking', result: null });
    let result;
    try {
      result = await api.aroflo.leadHistory(jn, editing?.id);
    } catch (err) {
      result = { found: false, kind: 'unavailable', message: err.message };
    }
    if (seq === historySeq.current) setHistory({ jn, status: 'done', result });
  }

  async function runArofloLeadSourceLookup(jobNumber) {
    const jn = (jobNumber || '').trim();
    if (!jn) return;
    setArofloLoading(true);
    setArofloResult(null);
    historySeq.current += 1;
    setHistory(null);
    try {
      const result = await api.aroflo.lookup(jn);
      setArofloResult({ jn, result });
      if (result?.found && form.callType === 'Lead') runCustomerHistory(jn);
    } catch (err) {
      setArofloResult({ jn, result: { found: false, message: err.message || 'AroFlo could not be reached — enter the details manually.' } });
    } finally {
      setArofloLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Contact Method and Call Type are required on every new record — only
    // checked here for a brand-new call, not when editing one, since every
    // existing call already has both set from before this was enforced.
    if (!editing && !form.direction) {
      setNotice('Please select a Contact Method before saving.', true);
      return;
    }
    if (!editing && !form.callType) {
      setNotice('Please select a Call Type before saving.', true);
      return;
    }
    // Booked is required for every Lead — on both a brand-new record and an
    // edit of an existing one. An older Lead saved before this rule existed
    // can still be opened/viewed with Booked blank; it just can't be saved
    // again until Booked is answered. Every other Call Type leaves Booked
    // optional (unless some other rule requires it).
    if (form.callType === 'Lead' && !form.booked) {
      setInvalidFields(new Set(['booked']));
      setNotice('Please select whether this Lead was Booked before saving.', true);
      return;
    }
    setInvalidFields(new Set());
    // Blocks a second submit while this one is in flight — see LogEntry.jsx.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (editing) {
        await api.calls.update(editing.id, form);
        setNotice('Call updated.');
      } else {
        await api.calls.create(form);
        setNotice('Call logged.');
      }
      onSaved();
      if (!editing) resetForm();
    } catch (err) {
      setNotice(err.message, true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const isCancellation = form.callType === 'Cancellation';
  const isPendingCancellation = isCancellation && form.cancellationType === 'Pending Cancellation';
  const showTrade = form.callType === 'Lead' || form.callType === 'Not lead' || isCancellation;
  const showLeadSource = form.callType === 'Lead';
  const showBooked = form.callType === 'Lead';
  const showNotBookedReason = showBooked && form.booked === 'No';
  const showCancellationType = isCancellation;
  const showCallBackReason = form.callType === 'Call back';
  const showJobNumber = ['Quote approved', 'Call back', 'Cancellation'].includes(form.callType) || (form.callType === 'Lead' && form.booked === 'Yes');
  const showJobLookup = ['Quote approved', 'Call back', 'Cancellation'].includes(form.callType);

  // A Pending Cancellation is about a job that's already been sold, so it
  // links against the sale record; everything else links against the job.
  const lookupMode = form.callType === 'Quote approved' || isPendingCancellation ? 'sale' : 'job';
  const lookupResult = useJobLookup(showJobLookup ? form.jobNumber : '', lookupMode);

  // Silently autofill trade/job type from whatever the JN matched, the same
  // way other auto-populated fields work — filled in, but never locked.
  // Follows the Job Number: correcting it takes back what the old job filled
  // (unless staff changed it) — see lib/lookupFill.js.
  const lookupFill = useRef({});
  useEffect(() => {
    const r = isCancellation && lookupResult?.found ? lookupResult : null;
    const { patch: changes, filled } = nextLookupFill(form, lookupFill.current, r ? { tradeId: r.tradeId, jobTypeId: r.jobTypeId } : {});
    lookupFill.current = filled;
    if (Object.keys(changes).length) patch(changes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupResult, isCancellation]);

  const cancellationReasonList =
    form.cancellationType === 'New Job Cancellation'
      ? settings.lists.new_job_cancellation_reason
      : form.cancellationType === 'Pending Cancellation'
      ? settings.lists.pending_cancellation_reason
      : [];

  const arofloSummary =
    arofloResult && arofloResult.jn === form.jobNumber.trim()
      ? callLookupSummary(arofloResult.result, form, { trades: settings.trades, leadSources: settings.lists.lead_source })
      : null;
  const leadDecision =
    arofloSummary && arofloSummary.found
      ? leadSourceDecision(arofloSummary.leadSource, history && history.jn === form.jobNumber.trim() ? history : null, form, settings.lists.lead_source)
      : null;

  return (
    <form onSubmit={handleSubmit} className="panel" style={{ padding: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{editing ? 'Update call' : 'New call record'}</div>
        {!editing && (
          <button type="button" className="btn" onClick={() => patch({ callAt: nowLocalDateTime() })}>
            Refresh time
          </button>
        )}
      </div>

      <div className="grid-form">
        <SelectField label="Contact Method *" value={form.direction} onChange={(v) => patch({ direction: v })} options={CONTACT_METHOD_OPTIONS} />
        <SelectField label="Handled by *" value={form.handledByUserId} onChange={(v) => patch({ handledByUserId: v })} options={settings.staff} />
        <DateTimeField label="Date & time *" value={form.callAt} onChange={(v) => patch({ callAt: v })} />
      </div>

      <div className="grid-form" style={{ marginTop: 14 }}>
        <SelectField
          label="Call type *"
          value={form.callType}
          onChange={(v) => {
            patch({ callType: v, booked: '', notBookedReasonId: '', cancellationType: '', cancellationReasonId: '', callBackReasonId: '' });
            setInvalidFields(new Set());
          }}
          options={CALL_TYPES}
        />
        {showBooked && (
          <SelectField
            label="Booked? *"
            value={form.booked}
            onChange={(v) => patch({ booked: v })}
            options={['Yes', 'No']}
            invalid={invalidFields.has('booked')}
          />
        )}
        {showCancellationType && (
          <SelectField
            label="Cancellation type"
            value={form.cancellationType}
            onChange={(v) => patch({ cancellationType: v, cancellationReasonId: '' })}
            options={CANCELLATION_TYPES}
          />
        )}
        {form.cancellationType && (
          <SelectField label="Reason for cancellation" value={form.cancellationReasonId} onChange={(v) => patch({ cancellationReasonId: v })} options={cancellationReasonList} />
        )}
        {showCallBackReason && (
          <SelectField label="Reason for call back" value={form.callBackReasonId} onChange={(v) => patch({ callBackReasonId: v })} options={settings.lists.callback_reason} />
        )}
      </div>

      {isCancellation && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
          <strong>New Job Cancellation</strong> = booked, but cancelled before a technician attended. <strong>Pending Cancellation</strong> = a
          technician attended and sold work, but the customer cancelled before we returned to complete it — this links to the job's sale by
          JN rather than creating a new job or sale.
        </div>
      )}

      {showNotBookedReason && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <SelectField label="Why wasn't it booked?" value={form.notBookedReasonId} onChange={(v) => patch({ notBookedReasonId: v })} options={settings.lists.not_booked_reason} />
        </div>
      )}

      {showTrade && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <SelectField label="Trade" value={form.tradeId} onChange={(v) => patch({ tradeId: v, jobTypeId: '' })} options={settings.trades} />
          <SelectField
            label="Job type"
            value={form.jobTypeId}
            onChange={(v) => patch({ jobTypeId: v })}
            options={settings.jobTypesFor(form.tradeId)}
            disabled={!form.tradeId}
            placeholder={form.tradeId ? '—' : 'Choose a trade first'}
          />
          {showLeadSource && (
            <SelectField label="Where did the lead come from?" value={form.leadSourceId} onChange={(v) => patch({ leadSourceId: v })} options={settings.lists.lead_source} />
          )}
        </div>
      )}

      <div className="grid-form" style={{ marginTop: 14 }}>
        {showJobNumber && (
          <div className="field">
            <label>Job number (JN)</label>
            <input className="mono" placeholder="e.g. 10432" value={form.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} />
            {showJobLookup && <JobLookupBox jobNumber={form.jobNumber} mode={lookupMode} result={lookupResult} />}
            {form.callType === 'Lead' && (
              <button
                type="button"
                className="btn"
                style={{ width: '100%', marginTop: 6 }}
                disabled={!form.jobNumber.trim() || arofloLoading}
                onClick={() => runArofloLeadSourceLookup(form.jobNumber)}
              >
                {arofloLoading ? 'Looking up…' : 'Look up in AroFlo'}
              </button>
            )}
            {form.callType === 'Lead' && arofloSummary && (
              <ArofloCallSuggestions summary={arofloSummary} decision={leadDecision} showLeadSource={showLeadSource} patch={patch} />
            )}
          </div>
        )}
        <SuburbPicker value={form.suburb} onChange={(v) => patch({ suburb: v })} />
      </div>

      <div style={{ marginTop: 14 }}>
        <TextAreaField label="Additional context" value={form.notes} onChange={(v) => patch({ notes: v })} placeholder="Anything relevant that isn't captured above" />
      </div>

      <div style={{ marginTop: 14 }}>
        <Checkbox label="Needs follow-up" checked={form.followUp} onChange={(v) => patch({ followUp: v })} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Update call' : 'Save call'}
        </button>
        {editing && (
          <button type="button" className="btn" onClick={onCancelEdit}>
            Cancel edit
          </button>
        )}
      </div>
    </form>
  );
}

// The result of "Look up in AroFlo" on a Lead call: why nothing was found,
// or AroFlo's task type / Lead Source with "Use this" where one of this
// CRM's options matches exactly. Clicking only changes the form.
function ArofloCallSuggestions({ summary, decision, showLeadSource, patch }) {
  if (!summary.found) {
    return <div className="lookup-box lookup-missing">{summary.message}</div>;
  }
  const row = (label, item, onUse, noMatchHint, { showArrow = true, emptyText = 'not set in AroFlo' } = {}) => (
    <div style={{ marginTop: 4 }}>
      {label}: {item.arofloValue ? <strong>{item.arofloValue}</strong> : <em>{emptyText}</em>}
      {item.suggestion && item.alreadySet && <> — already selected</>}
      {item.suggestion && !item.alreadySet && (
        <>
          {showArrow && <> → {item.suggestion.label}</>}{' '}
          <button className="btn btn-sm" type="button" onClick={onUse}>
            Use this
          </button>
        </>
      )}
      {!item.suggestion && item.arofloValue && <> — {noMatchHint}</>}
    </div>
  );
  return (
    <div className="lookup-box" style={{ border: '1px solid var(--border)', color: 'var(--ink)' }} data-testid="aroflo-call-lookup">
      <div>Found in AroFlo{summary.status ? ` (${summary.status.toLowerCase()})` : ''}. Nothing is changed until you click “Use this” and save.</div>
      {summary.jobType.kind === 'callback' ? (
        <div style={{ marginTop: 4 }}>
          Task type: <strong>{summary.jobType.arofloValue}</strong> — AroFlo records this job as a callback, which doesn&apos;t say the
          trade, so please choose the Trade / Job type above. The call type isn&apos;t changed.
        </div>
      ) : (
        row(
          'Task type',
          summary.jobType,
          () => patch({ tradeId: summary.jobType.suggestion.tradeId, jobTypeId: summary.jobType.suggestion.jobTypeId }),
          'no single matching Trade / Job type here, so please choose it above.'
        )
      )}
      {summary.jobType.kind === 'tradeOnly' && (
        <div style={{ fontSize: 12, marginTop: 2 }} data-testid="aroflo-jobtype-choices">
          AroFlo task type: {summary.jobType.arofloValue} — choose {summary.jobType.choices.map((c) => c.name).join(' or ')}.
        </div>
      )}
      {showLeadSource && decision && decision.mode !== 'normal' && <LeadSourceFromHistory decision={decision} patch={patch} />}
      {showLeadSource && decision?.mode === 'normal' && summary.leadSource.kind === 'conflict' && (
        <div style={{ marginTop: 4 }} data-testid="aroflo-lead-source-conflict">
          Customer’s Lead Source: AroFlo has two different values on this customer —{' '}
          {summary.leadSource.values.map((v, i) => (
            <span key={v.field}>
              {i > 0 && ' · '}
              {v.field}: <strong>{v.value}</strong>
            </span>
          ))}
          . Not chosen automatically — please pick the Lead Source above.
        </div>
      )}
      {showLeadSource &&
        decision?.mode === 'normal' &&
        summary.leadSource.kind !== 'conflict' &&
        row(
          'Customer’s Lead Source',
          summary.leadSource,
          () => patch({ leadSourceId: summary.leadSource.suggestion.leadSourceId }),
          summary.leadSource.kind === 'unmapped'
            ? 'not mapped to a CRM Lead Source — shown for reference only, please pick the Lead Source above.'
            : 'no single matching Lead Source here, so please pick the closest match above.'
        )}
      {row('Suburb', summary.suburb, () => patch({ suburb: summary.suburb.suggestion.suburb }), '', {
        showArrow: false,
        emptyText: 'no single confident match from the AroFlo job address, so please choose it in the Suburb field',
      })}
      {summary.suburb.addressForReference && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }} data-testid="aroflo-job-address">
          AroFlo job address (suburb part, for reference only): {summary.suburb.addressForReference}
        </div>
      )}
      {showLeadSource && decision?.mode === 'normal' && decision.warnings?.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--ink-muted)' }} data-testid="aroflo-repeat-warnings">
          {decision.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {showLeadSource && decision?.occupant && decision.mode !== 'checking' && decision.mode !== 'callback' && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }} data-testid="aroflo-occupant">
          Occupant (AroFlo): {decision.occupant} — for reference only.
        </div>
      )}
      {showLeadSource && decision?.mode === 'normal' && summary.leadSource.arofloValue && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
          AroFlo keeps Lead Source on the customer, so for a repeat customer it may show how they first found you rather than this
          enquiry — check before using it.
        </div>
      )}
    </div>
  );
}

// The Lead Source line once the automatic customer-history check has a
// say: checking, callback, Repeat customer or uncertain (see
// lib/arofloCallSuggest.js's leadSourceDecision). The customer's own AroFlo
// Lead Source is shown as reference only — never used for this enquiry.
function LeadSourceFromHistory({ decision, patch }) {
  const original = decision.original ? (
    <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }} data-testid="aroflo-original-lead-source">
      Original AroFlo Lead Source: {decision.original} (reference only — not used for this enquiry)
    </div>
  ) : null;
  return (
    <div style={{ marginTop: 4 }} data-testid={`aroflo-lead-history-${decision.mode}`}>
      {decision.mode === 'checking' && <div>Customer’s Lead Source: checking AroFlo customer history…</div>}
      {decision.mode === 'callback' && (
        <div>
          Customer’s Lead Source: this appears to be a <strong>callback</strong> ({decision.reasons.join('; ')}) — no Lead Source is
          suggested.
        </div>
      )}
      {decision.mode === 'repeat' && (
        <div>
          Customer’s Lead Source: <strong>{decision.suggestion.label}</strong> — AroFlo shows an earlier completed job
          {decision.earlierJob ? ` (JN ${decision.earlierJob.jobNumber}${decision.earlierJob.completed ? `, completed ${decision.earlierJob.completed}` : ''})` : ''} for
          this customer at the same address.{' '}
          {decision.alreadySet ? (
            <>— already selected</>
          ) : (
            <button className="btn btn-sm" type="button" onClick={() => patch({ leadSourceId: decision.suggestion.leadSourceId })}>
              Use this
            </button>
          )}
        </div>
      )}
      {decision.mode === 'uncertain' && (
        <div>
          Customer’s Lead Source: not suggested — the customer history is uncertain, so please pick the Lead Source above.
          {decision.reasons.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {decision.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {decision.mode !== 'checking' && original}
    </div>
  );
}
