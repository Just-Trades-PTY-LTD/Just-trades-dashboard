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
import { callLookupSummary, leadSourceDecision, planLeadCallFill, leadCallFillConfirmation, leadAutoFillAllowed, withTimeout, LEAD_CHECK_TIMEOUT_MS } from '../../lib/arofloCallSuggest.js';
import { BASIS_OPTIONS, basisLabel, detailsToState, selectInvoice, lostValueGuidance, detailsPayload, money, creditedTechnicianPlan } from '../../lib/pendingCancellationForm.js';
import { withInactiveLabel } from '../../lib/activeOptions.js';

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
  // Stage 5 — Pending Cancellation call: the affected invoice and lost value
  // (ex GST). Edited only here; sent only when staff change this section.
  const [pc, setPc] = useState(detailsToState(null));
  const [pcTouched, setPcTouched] = useState(false);
  const [pcInvoices, setPcInvoices] = useState(null); // { jn, loading, data, error }
  const pcAutoFilled = useRef(null);
  const pcTechFilled = useRef(null);

  useEffect(() => {
    setInvalidFields(new Set());
    setArofloResult(null);
    historySeq.current += 1;
    setHistory(null);
    setPc(detailsToState(editing?.pendingCancellation || null));
    setPcTouched(false);
    setPcInvoices(null);
    pcAutoFilled.current = null;
    pcTechFilled.current = null;
    // What a lookup filled belongs to the call it was filled on — never
    // carried over to another call (it could blank matching fields there).
    leadFill.current = {};
    lookupFill.current = {};
    callbackFill.current = {};
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
    setPc(detailsToState(null));
    setPcTouched(false);
    setPcInvoices(null);
    pcAutoFilled.current = null;
    pcTechFilled.current = null;
    leadFill.current = {};
    lookupFill.current = {};
    callbackFill.current = {};
    setArofloResult(null);
    historySeq.current += 1;
    setHistory(null);
  }

  async function runCustomerHistory(jn) {
    const seq = ++historySeq.current;
    setHistory({ jn, status: 'checking', result: null });
    let result;
    try {
      result = await withTimeout(api.aroflo.leadHistory(jn, editing?.id), LEAD_CHECK_TIMEOUT_MS, {
        found: false,
        kind: 'unavailable',
        timedOut: true,
        message: "AroFlo didn't answer in time.",
      });
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
      const result = await withTimeout(api.aroflo.lookup(jn), LEAD_CHECK_TIMEOUT_MS, {
        found: false,
        message: "AroFlo didn't answer in time — look up again, or enter the details yourself.",
      });
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
    if (leadCheckPending) {
      setNotice('Checking customer history and Lead Source… — please wait a moment before saving.', true);
      return;
    }
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
    const save = (confirmed) => {
      const body = { ...form };
      if (isPendingCancellation && pcTouched) body.pendingCancellationDetails = detailsPayload(pc, confirmed);
      // The Pending Cancellation's Credited technician — maintained only here.
      if (isPendingCancellation) body.pendingCancellationCreditedTechnicianId = pc.creditedTechnicianId || null;
      return editing ? api.calls.update(editing.id, body) : api.calls.create(body);
    };
    try {
      try {
        await save(false);
      } catch (err) {
        // Superseding, or another cancellation already on this invoice:
        // staff confirm first; nothing was saved yet.
        if (err.status !== 409 || !err.data?.needsConfirmation) throw err;
        if (!window.confirm(err.data.needsConfirmation.message)) {
          setNotice('Not saved — nothing was changed.', true);
          return;
        }
        await save(true);
      }
      setNotice(editing ? 'Call updated.' : 'Call logged.');
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
  const isCallBackCall = form.callType === 'Call back';
  // Call back: Trade / Job type record what kind of callback work it relates
  // to (the call type stays Call back).
  const showTrade = form.callType === 'Lead' || form.callType === 'Not lead' || isCancellation || isCallBackCall;
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

  // Call back: prefill Trade / Job type from the original CRM job (a Call
  // Back entry linking this new callback Job Number to its original job, or
  // a CRM job with this Job Number). Blank fields only, follows the Job
  // Number, always editable; never from AroFlo's generic "Call Back" type.
  const callbackOrigin = useJobLookup(isCallBackCall ? form.jobNumber : '', 'callbackOrigin');
  const callbackFill = useRef({});
  useEffect(() => {
    const r = isCallBackCall && callbackOrigin?.found && callbackOrigin.tradeId ? callbackOrigin : null;
    const same = (x, y) => String(x ?? '') === String(y ?? '');
    const usable = r && (!form.tradeId || same(form.tradeId, callbackFill.current.tradeId) || same(form.tradeId, r.tradeId));
    const { patch: changes, filled } = nextLookupFill(form, callbackFill.current, usable ? { tradeId: r.tradeId, jobTypeId: r.jobTypeId } : {});
    callbackFill.current = filled;
    if (Object.keys(changes).length) patch(changes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbackOrigin, isCallBackCall]);

  // Pending Cancellation: a different Job Number drops an invoice chosen for
  // the previous one (staff choose again from the new list).
  useEffect(() => {
    const jn = form.jobNumber.trim();
    if (pcTouched && pc.invoiceNumber && pcInvoices?.jn && pcInvoices.jn !== jn) setPc((cur) => selectInvoice(cur, null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.jobNumber]);
  // Entire invoice cancelled: fill the lost value only when it's clear (CRM
  // and AroFlo agree) and the field is blank or still holds this fill.
  const pcGuidance = lostValueGuidance(pc);
  useEffect(() => {
    if (!pcTouched) return;
    const mine = pcAutoFilled.current !== null && pc.lostValueExGst === pcAutoFilled.current;
    if (pcGuidance.fill !== null && (pc.lostValueExGst === '' || mine)) {
      const v = String(pcGuidance.fill);
      pcAutoFilled.current = v;
      if (pc.lostValueExGst !== v) setPc((cur) => ({ ...cur, lostValueExGst: v }));
    } else if (pcGuidance.fill === null && mine) {
      pcAutoFilled.current = null;
      setPc((cur) => ({ ...cur, lostValueExGst: '' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcTouched, pc.invoiceKey, pc.lostValueBasis, pcGuidance.fill]);

  // Credited technician: from the CRM sale for the exact selected invoice
  // (or the Job Number's only sale); blank or own fill only — a technician
  // staff chose is never replaced (creditedTechnicianPlan).
  const pcListForJn = pcInvoices?.data && pcInvoices.jn === form.jobNumber.trim() ? pcInvoices.data.invoices : null;
  const pcTechPlan = isPendingCancellation ? creditedTechnicianPlan({ pc, invoices: pcListForJn, filled: pcTechFilled.current }) : null;
  useEffect(() => {
    if (!pcTechPlan || pcTechPlan.set === null) return;
    pcTechFilled.current = pcTechPlan.set || null;
    setPc((cur) => ({ ...cur, creditedTechnicianId: pcTechPlan.set }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPendingCancellation, pc.invoiceKey, pcListForJn]);

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

  // A booked Lead call's AroFlo lookup / customer-history check is running
  // for the Job Number in the form: Save waits for it (each step gives up
  // after LEAD_CHECK_TIMEOUT_MS, so the form can't get stuck).
  const leadCheckPending =
    form.callType === 'Lead' &&
    !!form.jobNumber.trim() &&
    (arofloLoading || (history?.status === 'checking' && history.jn === form.jobNumber.trim()));
  const leadHistoryFailed =
    form.callType === 'Lead' && history?.status === 'done' && history.jn === form.jobNumber.trim() && history.result?.kind === 'unavailable'
      ? history.result.timedOut
        ? 'timeout'
        : 'failed'
      : null;

  // Stage 2: a booked Lead call's lookup fills BLANK Suburb, Trade / Job type
  // and (once the customer-history check is done) Lead Source — see
  // planLeadCallFill. Follows the Job Number: a different Job Number takes
  // back what this filled, unless staff changed it (lib/lookupFill.js).
  // Never replaces a staff choice; nothing is saved until Save.
  const leadFill = useRef({});
  useEffect(() => {
    const isLead = form.callType === 'Lead' && leadAutoFillAllowed(editing);
    // Plan against the form with this source's own earlier fills treated as
    // blank, so they're kept (not taken back) while still wanted.
    const planForm = { ...form };
    Object.entries(leadFill.current).forEach(([f, v]) => {
      if (String(planForm[f] ?? '') === String(v ?? '')) planForm[f] = '';
    });
    const wanted = isLead && arofloSummary ? planLeadCallFill({ summary: arofloSummary, decision: leadDecision, form: planForm }).wanted : {};
    const { patch: changes, filled } = nextLookupFill(form, leadFill.current, wanted);
    leadFill.current = filled;
    if (Object.keys(changes).length) patch(changes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arofloResult, history, form.jobNumber, form.callType]);

  // Runs the lookup automatically when staff leave the Job Number field on a
  // booked Lead call — a new call, or an edit whose Job Number was changed
  // (opening an old call never changes it on its own). Not repeated for a
  // Job Number already looked up; "Look up in AroFlo" stays available.
  // Pending Cancellation: list the Job Number's invoices (CRM + AroFlo,
  // read-only) when staff leave the Job Number field on a new call, or after
  // changing it; "Look up invoices" is always there too.
  async function loadPcInvoices(jobNumber) {
    const jn = (jobNumber || '').trim();
    if (!jn) return;
    setPcInvoices({ jn, loading: true });
    try {
      const data = await api.aroflo.pendingCancellationInvoices(jn, editing?.pendingCancellation?.id);
      setPcInvoices((cur) => (cur?.jn === jn ? { jn, data } : cur));
    } catch (err) {
      setPcInvoices((cur) => (cur?.jn === jn ? { jn, error: err.message } : cur));
    }
  }
  function autoLoadPcInvoices() {
    const jn = form.jobNumber.trim();
    if (!isPendingCancellation || !jn || pcInvoices?.jn === jn) return;
    if (editing && jn === String(editing.jobNumber || '').trim()) return;
    loadPcInvoices(jn);
  }
  function patchPc(changes) {
    setPcTouched(true);
    setPc((cur) => ({ ...cur, ...changes }));
  }

  function autoLookupLead() {
    const jn = form.jobNumber.trim();
    if (form.callType !== 'Lead' || form.booked !== 'Yes' || !jn || arofloLoading) return;
    if (editing && jn === String(editing.jobNumber || '').trim()) return;
    if (arofloResult?.jn === jn) return;
    runArofloLeadSourceLookup(jn);
  }

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
          {isCallBackCall && (
            <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: 'var(--ink-muted)' }} data-testid="callback-trade-note">
              {callbackOriginNote(form, callbackOrigin, callbackFill.current)}
            </div>
          )}
        </div>
      )}

      <div className="grid-form" style={{ marginTop: 14 }}>
        {showJobNumber && (
          <div className="field">
            <label>Job number (JN)</label>
            <input
              className="mono"
              placeholder="e.g. 10432"
              value={form.jobNumber}
              onChange={(e) => patch({ jobNumber: e.target.value })}
              onBlur={() => {
                autoLookupLead();
                autoLoadPcInvoices();
              }}
            />
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
              <ArofloCallSuggestions
                summary={arofloSummary}
                decision={leadDecision}
                showLeadSource={showLeadSource}
                patch={patch}
                filledNote={leadCallFillConfirmation(leadFill.current)}
                historyFailed={leadHistoryFailed}
                autoFill={leadAutoFillAllowed(editing)}
              />
            )}
          </div>
        )}
        <SuburbPicker value={form.suburb} onChange={(v) => patch({ suburb: v })} />
      </div>

      {isPendingCancellation && (
        <PendingCancellationInvoice
          jobNumber={form.jobNumber.trim()}
          saved={editing?.pendingCancellation || null}
          pc={pc}
          touched={pcTouched}
          invoices={pcInvoices}
          guidance={pcGuidance}
          autoFilled={pcAutoFilled.current !== null && pc.lostValueExGst === pcAutoFilled.current}
          onLoad={() => loadPcInvoices(form.jobNumber)}
          onChange={patchPc}
          technicians={withInactiveLabel(settings.technicians)}
          techPlan={pcTechPlan}
          techAutoFilled={!!pcTechFilled.current && String(pc.creditedTechnicianId) === String(pcTechFilled.current)}
        />
      )}

      <div style={{ marginTop: 14 }}>
        <TextAreaField label="Additional context" value={form.notes} onChange={(v) => patch({ notes: v })} placeholder="Anything relevant that isn't captured above" />
      </div>

      <div style={{ marginTop: 14 }}>
        <Checkbox label="Needs follow-up" checked={form.followUp} onChange={(v) => patch({ followUp: v })} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button type="submit" className="btn btn-primary" disabled={saving || leadCheckPending} data-testid="save-call">
          {saving ? 'Saving…' : leadCheckPending ? 'Checking customer history…' : editing ? 'Update call' : 'Save call'}
        </button>
        {leadCheckPending && (
          <span style={{ fontSize: 12, color: 'var(--ink-muted)', alignSelf: 'center' }} data-testid="lead-check-pending">
            Checking customer history and Lead Source… Save is available again in a moment.
          </span>
        )}
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
function ArofloCallSuggestions({ summary, decision, showLeadSource, patch, filledNote, historyFailed, autoFill }) {
  if (!summary.found) {
    return (
      <div className="lookup-box lookup-missing" data-testid="aroflo-call-not-found">
        {summary.message} If the job isn&apos;t booked in AroFlo yet, use “Look up in AroFlo” again once it is — nothing was filled in.
      </div>
    );
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
      <div>
        Found in AroFlo{summary.status ? ` (${summary.status.toLowerCase()})` : ''}.{' '}
        {autoFill
          ? 'Blank fields are filled where AroFlo is clear; nothing is saved until you save the call.'
          : 'This call already had a Job Number, so nothing is filled in — use "Use this" for anything you want to change.'}
      </div>
      {showLeadSource && historyFailed && (
        <div className="lookup-box lookup-missing" style={{ marginTop: 4 }} data-testid="aroflo-history-failed">
          Lead Source couldn&apos;t be checked (the customer-history check {historyFailed === 'timeout' ? "didn't answer in time" : 'failed'}), so it was left
          for you to choose.
        </div>
      )}
      {filledNote && (
        <div className="lookup-box lookup-found" style={{ marginTop: 4 }} data-testid="aroflo-call-filled">
          ✓ {filledNote}
        </div>
      )}
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
      {decision.mode === 'checking' && <div data-testid="aroflo-history-checking">Checking customer history and Lead Source…</div>}
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

// What the Call back call's Trade / Job type note says about where they came from.
function callbackOriginNote(form, origin, filled) {
  const jn = (form.jobNumber || '').trim();
  const base = 'The type of work this callback relates to — the call type stays Call back.';
  if (!jn) return `${base} Enter the Job Number to prefill it from the original job, or choose it here.`;
  if (!origin) return base;
  if (origin.found) {
    const via = origin.source === 'callBackEntry' ? `the Call Back entry's original job JN ${origin.originalJobNumber}` : `the original job JN ${origin.originalJobNumber}`;
    const label = [origin.trade, origin.jobType].filter(Boolean).join(' — ') || 'no Trade recorded';
    if (filled.tradeId) return `${base} Prefilled from ${via} (${label}) — change it if the callback work is different.`;
    return `${base} The original job (${via}) is ${label}.`;
  }
  if (origin.source === 'callBackEntryNoJob') return `${base} The Call Back entry's original job JN ${origin.originalJobNumber} isn't in the CRM — please choose it.`;
  if (origin.source === 'conflict') return `${base} Call Back entries link this Job Number to different original jobs — please choose it.`;
  return `${base} No original CRM job found for JN ${jn} — please choose it.`;
}

// Stage 5 — the affected invoice and lost value on a Pending Cancellation
// call. One invoice at a time (never combined); the lost value is always ex
// GST and always editable. Recorded only here, on the call.
function PendingCancellationInvoice({ jobNumber, saved, pc, touched, invoices, guidance, autoFilled, onLoad, onChange, technicians, techPlan, techAutoFilled }) {
  const list = invoices && invoices.jn === jobNumber ? invoices : null;
  const notRecorded = !touched && !(saved && saved.recorded);
  const describeOthers = (others) =>
    others
      .map((o) => `${o.lostValueExGst === null ? 'amount not recorded' : `${money(o.lostValueExGst)} ex GST`} (${basisLabel(o.basis) || 'basis not recorded'}, ${o.dateLogged})${o.supersededById ? ' — superseded' : ''}`)
      .join('; ');
  return (
    <div className="panel" style={{ padding: 16, marginTop: 14, background: 'var(--surface-2)' }} data-testid="pc-invoice">
      <div style={{ fontSize: 13, fontWeight: 600 }}>Affected invoice and lost value (ex GST)</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 2 }}>
        Information on this cancellation only — it never changes the sale, its revenue or any report figure.
      </div>
      {saved?.supersededById && (
        <div className="lookup-box lookup-missing" style={{ marginTop: 8 }} data-testid="pc-superseded">
          Superseded for reporting by a later entire-invoice cancellation on the same invoice. This record stays in history and won&apos;t be counted twice.
        </div>
      )}
      {saved?.supersedes?.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 6 }} data-testid="pc-supersedes">
          Supersedes {saved.supersedes.length === 1 ? 'an earlier cancellation' : `${saved.supersedes.length} earlier cancellations`} on this invoice (
          {saved.supersedes.map((x) => `${money(x.lostValueExGst)} ex GST, ${x.dateLogged}`).join('; ')}) — kept in history.
        </div>
      )}
      {notRecorded && (
        <div style={{ fontSize: 12.5, marginTop: 8 }} data-testid="pc-not-recorded">
          Invoice and lost value: <strong>not recorded</strong>. You can select the invoice and enter the lost value below — nothing is filled in on its own.
        </div>
      )}
      {(touched || saved?.recorded) && pc.invoiceNumber && (
        <div style={{ fontSize: 12.5, marginTop: 8 }} data-testid="pc-selected">
          Invoice <strong>{pc.invoiceNumber}</strong>
          {pc.invoiceDate ? ` · ${pc.invoiceDate}` : ''} · CRM recorded {pc.crmValueExGst === null ? 'not on a CRM sale' : `${money(pc.crmValueExGst)} ex GST`} · AroFlo{' '}
          {pc.arofloInvoiceValueExGst === null ? 'value not available' : `${money(pc.arofloInvoiceValueExGst)} ex GST`}
          {pc.arofloInvoiceStatus ? ` · ${pc.arofloInvoiceStatus}` : ''}
        </div>
      )}
      <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} disabled={!jobNumber || list?.loading} onClick={onLoad}>
        {list?.loading ? 'Looking up invoices…' : `Look up invoices for JN ${jobNumber || '—'}`}
      </button>
      {list?.error && <div className="lookup-box lookup-missing" style={{ marginTop: 6 }}>{list.error}</div>}
      {list?.data && (
        <div style={{ marginTop: 8, fontSize: 12.5 }} data-testid="pc-invoice-list">
          {list.data.arofloNote && <div style={{ color: 'var(--ink-muted)', marginBottom: 4 }}>{list.data.arofloNote}</div>}
          {list.data.invoices.length === 0 && <div>No invoice found for this Job Number — the lost value can still be entered yourself.</div>}
          {list.data.invoices.map((inv) => (
            <label key={inv.key} style={{ display: 'block', marginTop: 4 }}>
              <input
                type="radio"
                name="pc-invoice"
                checked={pc.invoiceKey === inv.key}
                onChange={() => onChange(selectInvoice(pc, inv, list.data.capturedAt))}
              />{' '}
              Invoice <strong>{inv.invoiceNumber}</strong>
              {inv.invoiceDate ? ` · ${inv.invoiceDate}` : ''} · CRM recorded{' '}
              {inv.crm ? `${money(inv.crm.valueExGst)} ex GST${inv.crm.upsellCount ? ` (incl. ${money(inv.crm.upsellValueExGst)} Upsell${inv.crm.upsellCount > 1 ? 's' : ''})` : ''}` : 'not on a CRM sale'} · AroFlo{' '}
              {inv.aroflo ? `${inv.aroflo.valueExGst === null ? 'value not shown' : `${money(inv.aroflo.valueExGst)} ex GST`}${inv.aroflo.status ? ` · ${inv.aroflo.status}` : ''}` : 'not found'}
              {inv.otherCancellations.length > 0 && (
                <span style={{ color: 'var(--warning, #a15c00)' }}> · already has a cancellation: {describeOthers(inv.otherCancellations)}</span>
              )}
            </label>
          ))}
          {list.data.invoices.length > 0 && (
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="pc-invoice" checked={!pc.invoiceKey} onChange={() => onChange(selectInvoice(pc, null))} /> None of these / not sure
            </label>
          )}
        </div>
      )}
      <div className="field" style={{ marginTop: 10, maxWidth: 420 }} data-testid="pc-credited-technician">
        <SelectField label="Credited technician" value={pc.creditedTechnicianId} onChange={(v) => onChange({ creditedTechnicianId: v })} options={technicians} />
        <div style={{ fontSize: 12, marginTop: 4 }} data-testid="pc-credited-technician-note">
          {techAutoFilled && techPlan?.source && `Filled from the CRM sale for invoice ${techPlan.source.invoiceNumber} (${techPlan.source.name}) — still editable.`}
          {techPlan?.difference && (
            <>
              The CRM sale for invoice {techPlan.difference.invoiceNumber} is credited to <strong>{techPlan.difference.name}</strong> — the technician selected
              above was kept.{' '}
              <button type="button" className="btn btn-sm" onClick={() => onChange({ creditedTechnicianId: techPlan.difference.id })}>
                Use {techPlan.difference.name}
              </button>
            </>
          )}
          {techPlan?.note}
          {!(techAutoFilled && techPlan?.source) && !techPlan?.difference && !techPlan?.note && 'Who receives this cancellation — choose or correct it here.'}
        </div>
      </div>
      <div style={{ marginTop: 10, fontSize: 12.5 }} data-testid="pc-basis">
        {BASIS_OPTIONS.map((o) => (
          <label key={o.value} style={{ marginRight: 16 }}>
            <input type="radio" name="pc-basis" checked={pc.lostValueBasis === o.value} onChange={() => onChange({ lostValueBasis: o.value })} /> {o.label}
          </label>
        ))}
      </div>
      <div className="field" style={{ marginTop: 8, maxWidth: 320 }}>
        <label>Lost value (ex GST)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={pc.lostValueExGst}
          onChange={(e) => onChange({ lostValueExGst: e.target.value })}
          data-testid="pc-lost-value"
        />
      </div>
      {(touched || saved?.recorded) && (
        <div style={{ fontSize: 12, marginTop: 4 }} data-testid="pc-guidance">
          {guidance.text}
          {autoFilled && ' Filled in from the invoice — still editable.'}
          {guidance.offer !== null && String(guidance.offer) !== String(pc.lostValueExGst) && (
            <>
              {' '}
              <button type="button" className="btn btn-sm" onClick={() => onChange({ lostValueExGst: String(guidance.offer) })}>
                Use {money(guidance.offer)}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
