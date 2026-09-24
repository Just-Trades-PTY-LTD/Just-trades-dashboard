import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useJobLookup } from '../../lib/useLookup.js';
import { todayLocalDate } from '../../lib/dates.js';
import { DateField, NumberField, SelectField, TextAreaField, YesNoField } from '../../components/Fields.jsx';
import { JobLookupBox } from '../../components/JobLookupBox.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';

const ENTRY_TYPES = [
  ['new_job_no_sale', 'New Job — No Sale'],
  ['new_job_sale_made', 'New Job — Sale Made'],
  ['quote_approved_later', 'Existing Job — Quote Approved Later'],
  ['call_back', 'Call Back'],
  // Pending Cancellation is no longer creatable here — it's logged through
  // Calls (Cancellation → Pending Cancellation) and links to the existing
  // sale by job number instead of creating a new job or sale. Kept out of
  // this list except when editing one already on record (below), so any
  // older entries remain viewable/editable.
  ['pending_cancellation', 'Pending Cancellation'],
];
const LEAD_OPTIONS = ['Qualified', 'Not Qualified'];
const WORK_COMPLETION_OPTIONS = ['Completed on this visit', 'Install scheduled — different day'];

function emptyForm(kind) {
  return {
    // Entry type starts blank ("—") and must be deliberately chosen before
    // saving — see the mandatory check in handleSubmit().
    kind: kind || '',
    visitDate: todayLocalDate(),
    dateLogged: todayLocalDate(),
    technicianId: '',
    creditedTechnicianId: '',
    jobNumber: '',
    tradeId: '',
    jobTypeId: '',
    lead: '',
    inspectionSheet: '',
    optionSheet: '',
    knockbackReasonId: '',
    workCompletion: '',
    installTechnicianId: '',
    installDate: '',
    invoiceNumber: '',
    // Defaults to today, same as visitDate/dateLogged above — still a normal
    // editable field, in case the invoice was actually created on a
    // different day.
    invoiceDate: todayLocalDate(),
    saleValueExGst: '',
    callBackReasonId: '',
    pendingCancellationReasonId: '',
    comments: '',
  };
}

function fromEntry(entry) {
  return {
    kind: entry.kind,
    visitDate: entry.visitDate || todayLocalDate(),
    dateLogged: entry.dateShown || todayLocalDate(),
    technicianId: entry.technicianId || '',
    creditedTechnicianId: entry.creditedTechnicianId || '',
    jobNumber: entry.jobNumber || '',
    tradeId: entry.tradeId || '',
    jobTypeId: entry.jobTypeId || '',
    lead: entry.lead || '',
    inspectionSheet: entry.inspectionSheet || '',
    optionSheet: entry.optionSheet || '',
    knockbackReasonId: entry.knockbackReasonId || '',
    workCompletion: entry.workCompletion || '',
    installTechnicianId: entry.installTechnicianId || '',
    installDate: entry.installDate || '',
    invoiceNumber: entry.invoiceNumber || '',
    invoiceDate: entry.invoiceDate || '',
    saleValueExGst: entry.saleValueExGst ?? '',
    callBackReasonId: entry.reasonId || '',
    pendingCancellationReasonId: entry.reasonId || '',
    comments: entry.comments || '',
  };
}

export default function LogEntry({ editing, onSaved, onCancelEdit, setNotice }) {
  const settings = useSettings();
  const [form, setForm] = useState(emptyForm());
  const [invalidFields, setInvalidFields] = useState(new Set());

  useEffect(() => {
    setForm(editing ? fromEntry(editing) : emptyForm());
    setInvalidFields(new Set());
  }, [editing]);

  function patch(p) {
    setForm((f) => ({ ...f, ...p }));
  }

  const isNewJob = form.kind === 'new_job_no_sale' || form.kind === 'new_job_sale_made';
  const isSaleMade = form.kind === 'new_job_sale_made';
  const isExistingJob = form.kind === 'quote_approved_later';
  const isCallBack = form.kind === 'call_back';
  const isPendingCancellation = form.kind === 'pending_cancellation';
  const showInstallFields = form.workCompletion === 'Install scheduled — different day';
  // A No Sale entry only counts as a genuine knock-back when the lead was
  // Qualified — see the matching rule in reports.js/techSales.js. An
  // Unqualified lead was never a real sales opportunity, so it's never
  // flagged (or required to explain) a knock-back.
  const isGenuineKnockback = form.kind === 'new_job_no_sale' && form.lead === 'Qualified';
  const knockbackReason = settings.lists.knockback_reason.find((r) => String(r.id) === String(form.knockbackReasonId));
  const knockbackReasonIsOther = knockbackReason?.name === 'Other';

  const jobLookupMode = isPendingCancellation ? 'sale' : 'job';
  const showJobLookup = isExistingJob || isCallBack || isPendingCancellation;
  const lookupResult = useJobLookup(showJobLookup ? form.jobNumber : '', jobLookupMode);
  // A brand-new job entered under a Job Number that already belongs to
  // another active job — surfaced as a warning as soon as it's typed, and
  // blocked at submit (see validate() below) rather than silently creating a
  // second, conflicting job on the same JN. Only relevant when creating —
  // editing an existing job will always "match" its own record, which isn't
  // a duplicate.
  const newJobDuplicateCheck = useJobLookup(isNewJob && !editing ? form.jobNumber : '', 'job');

  // Silently autofill the credited technician, trade and job type from the
  // matched job/sale, the way the prototype's lookup effect did — filled in
  // automatically where possible, but always left editable in case the match
  // needs correcting.
  useEffect(() => {
    if (!lookupResult || !lookupResult.found) return;
    if (isExistingJob || isCallBack) {
      const fill = {};
      if (lookupResult.technicianId && !form.creditedTechnicianId) fill.creditedTechnicianId = lookupResult.technicianId;
      if (lookupResult.tradeId && !form.tradeId) fill.tradeId = lookupResult.tradeId;
      if (lookupResult.jobTypeId && !form.jobTypeId) fill.jobTypeId = lookupResult.jobTypeId;
      if (Object.keys(fill).length) patch(fill);
    } else if (isPendingCancellation) {
      if (lookupResult.creditedTechnicianId && !form.creditedTechnicianId) patch({ creditedTechnicianId: lookupResult.creditedTechnicianId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupResult]);

  function changeEntryType(kind) {
    setForm(emptyForm(kind));
    setInvalidFields(new Set());
  }

  // Returns { missing: string[], fields: Set<string> } — every required
  // field that's still blank for the current entry type, named clearly
  // enough to show the user exactly what to fix, plus the set of field keys
  // to visually highlight.
  function validate() {
    const missing = [];
    const fields = new Set();
    if (!form.kind) {
      return { missing: ['Entry type'], fields: new Set(['kind']) };
    }
    if (isNewJob) {
      if (!form.visitDate) {
        missing.push('Visit Date');
        fields.add('visitDate');
      }
      if (!form.technicianId) {
        missing.push('Technician');
        fields.add('technicianId');
      }
      if (!form.jobNumber || !form.jobNumber.trim()) {
        missing.push('Job Number');
        fields.add('jobNumber');
      }
      if (!form.tradeId) {
        missing.push('Trade');
        fields.add('tradeId');
      }
      if (!form.jobTypeId) {
        missing.push('Job Type');
        fields.add('jobTypeId');
      }
      if (!form.lead) {
        missing.push('Lead status (Qualified or Unqualified)');
        fields.add('lead');
      }
      if (isGenuineKnockback) {
        if (!form.knockbackReasonId) {
          missing.push('Reason for Knockback');
          fields.add('knockbackReasonId');
        } else if (knockbackReasonIsOther && !form.comments.trim()) {
          missing.push('Additional Comments (required when Reason for Knockback is "Other")');
          fields.add('comments');
        }
      }
      if (newJobDuplicateCheck?.found) {
        missing.push(`a different Job Number — ${form.jobNumber} already exists`);
        fields.add('jobNumber');
      }
    } else if (!form.jobNumber || !form.jobNumber.trim()) {
      missing.push('Job Number');
      fields.add('jobNumber');
    }
    return { missing, fields };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Every check in validate() only applies to a brand-new entry — editing
    // an existing one is never blocked by it, so an older record missing one
    // of these values can still be edited without being forced to fill in
    // something it never recorded.
    if (!editing) {
      const { missing, fields } = validate();
      if (missing.length) {
        setInvalidFields(fields);
        setNotice(`Please complete the following before saving: ${missing.join(', ')}.`, true);
        return;
      }
    }
    setInvalidFields(new Set());
    try {
      let res;
      if (isNewJob) {
        const body = {
          kind: form.kind,
          visitDate: form.visitDate,
          technicianId: form.technicianId || null,
          jobNumber: form.jobNumber,
          tradeId: form.tradeId || null,
          jobTypeId: form.jobTypeId || null,
          lead: form.lead,
          inspectionSheet: form.inspectionSheet,
          optionSheet: form.optionSheet,
          knockbackReasonId: form.knockbackReasonId || null,
          workCompletion: form.workCompletion,
          installTechnicianId: form.installTechnicianId || null,
          installDate: form.installDate,
          invoiceNumber: form.invoiceNumber,
          invoiceDate: form.invoiceDate,
          saleValueExGst: form.saleValueExGst,
          comments: form.comments,
        };
        res = editing ? { entry: await api.tech.updateNewJob(editing.id, body) } : await api.tech.createNewJob(body);
      } else if (isExistingJob) {
        const body = {
          jobNumber: form.jobNumber,
          dateLogged: form.dateLogged,
          creditedTechnicianId: form.creditedTechnicianId || null,
          tradeId: form.tradeId || null,
          jobTypeId: form.jobTypeId || null,
          invoiceNumber: form.invoiceNumber,
          invoiceDate: form.invoiceDate,
          saleValueExGst: form.saleValueExGst,
          comments: form.comments,
        };
        res = editing ? { entry: await api.tech.updateQuoteApprovedLater(editing.id, body) } : await api.tech.createQuoteApprovedLater(body);
      } else if (isCallBack) {
        const body = {
          jobNumber: form.jobNumber,
          visitDate: form.visitDate,
          technicianId: form.technicianId || null,
          creditedTechnicianId: form.creditedTechnicianId || null,
          tradeId: form.tradeId || null,
          jobTypeId: form.jobTypeId || null,
          reasonId: form.callBackReasonId || null,
          comments: form.comments,
        };
        res = editing ? { entry: await api.tech.updateCallBack(editing.id, body) } : await api.tech.createCallBack(body);
      } else {
        const body = {
          jobNumber: form.jobNumber,
          dateLogged: form.dateLogged,
          creditedTechnicianId: form.creditedTechnicianId || null,
          reasonId: form.pendingCancellationReasonId || null,
          comments: form.comments,
        };
        res = editing
          ? { entry: await api.tech.updatePendingCancellation(editing.id, body) }
          : await api.tech.createPendingCancellation(body);
      }

      if (res.notice) setNotice(res.notice);
      else setNotice(editing ? 'Entry updated.' : 'Entry logged.');
      onSaved();
      if (!editing) changeEntryType(form.kind);
    } catch (err) {
      setNotice(err.message, true);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel" style={{ padding: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{editing ? 'Update entry' : 'New entry'}</div>
      </div>

      <SelectField
        label="Entry type *"
        value={form.kind}
        onChange={changeEntryType}
        options={ENTRY_TYPES.filter(([id]) => id !== 'pending_cancellation' || form.kind === 'pending_cancellation').map(([id, label]) => ({
          id,
          name: label,
        }))}
        placeholder="—"
        invalid={invalidFields.has('kind')}
      />

      {isExistingJob && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>
          Use this for a delayed quote approval, or to add an extra invoice to a job that already had a sale.
        </div>
      )}
      {isCallBack && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>
          A return visit on work already completed — this does not count as a new job, lead, or sale.
        </div>
      )}
      {isPendingCancellation && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>
          A job that was already sold and invoiced, now being cancelled/refunded while AroFlo processes the close-out. This does not
          automatically change sales or bonus totals.
        </div>
      )}

      {showJobLookup && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <div className={`field${invalidFields.has('jobNumber') ? ' invalid' : ''}`}>
            <label>Job number (JN) *</label>
            <input className="mono" placeholder="e.g. 10432" value={form.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} />
            <JobLookupBox jobNumber={form.jobNumber} mode={jobLookupMode} result={lookupResult} />
          </div>
        </div>
      )}

      {isNewJob && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <DateField label="Visit date *" value={form.visitDate} onChange={(v) => patch({ visitDate: v })} invalid={invalidFields.has('visitDate')} />
          <SelectField
            label="Technician *"
            value={form.technicianId}
            onChange={(v) => patch({ technicianId: v })}
            options={settings.activeTechniciansFor(form.technicianId)}
            invalid={invalidFields.has('technicianId')}
          />
          <div className={`field${invalidFields.has('jobNumber') ? ' invalid' : ''}`}>
            <label>Job number (JN) *</label>
            <input className="mono" placeholder="e.g. 10432" value={form.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} />
            {newJobDuplicateCheck?.found && (
              <div className="lookup-box lookup-missing">
                Job Number {form.jobNumber} already exists (visit {newJobDuplicateCheck.visitDate}
                {newJobDuplicateCheck.trade ? ` — ${newJobDuplicateCheck.trade}` : ''}). If this is a follow-up on that job, use "Existing
                Job — Quote Approved Later" or "Call Back" instead.
              </div>
            )}
          </div>
        </div>
      )}

      {isCallBack && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <DateField label="Visit date *" value={form.visitDate} onChange={(v) => patch({ visitDate: v })} invalid={invalidFields.has('visitDate')} />
          <SelectField
            label="Attending technician *"
            value={form.technicianId}
            onChange={(v) => patch({ technicianId: v })}
            options={settings.activeTechniciansFor(form.technicianId)}
            invalid={invalidFields.has('technicianId')}
          />
          <SelectField
            label="Credited technician (original work)"
            value={form.creditedTechnicianId}
            onChange={(v) => patch({ creditedTechnicianId: v })}
            options={withInactiveLabel(settings.technicians)}
          />
        </div>
      )}

      {(isExistingJob || isPendingCancellation) && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <DateField label="Date entered" value={form.dateLogged} onChange={(v) => patch({ dateLogged: v })} />
          <SelectField
            label="Credited technician"
            value={form.creditedTechnicianId}
            onChange={(v) => patch({ creditedTechnicianId: v })}
            options={withInactiveLabel(settings.technicians)}
          />
        </div>
      )}

      {(isNewJob || isExistingJob || isCallBack) && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <SelectField
            label={isNewJob ? 'Trade *' : 'Trade'}
            value={form.tradeId}
            onChange={(v) => patch({ tradeId: v, jobTypeId: '' })}
            options={settings.trades}
            invalid={invalidFields.has('tradeId')}
          />
          <SelectField
            label={isNewJob ? 'Job type *' : 'Job type'}
            value={form.jobTypeId}
            onChange={(v) => patch({ jobTypeId: v })}
            options={settings.jobTypesFor(form.tradeId)}
            disabled={!form.tradeId}
            placeholder={form.tradeId ? '—' : 'Choose a trade first'}
            invalid={invalidFields.has('jobTypeId')}
          />
          {isNewJob && (
            <SelectField
              label="Lead *"
              value={form.lead}
              onChange={(v) => patch({ lead: v })}
              options={LEAD_OPTIONS}
              invalid={invalidFields.has('lead')}
            />
          )}
        </div>
      )}

      {isNewJob && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <YesNoField label="Inspection sheet" value={form.inspectionSheet} onChange={(v) => patch({ inspectionSheet: v })} />
          <YesNoField label="Option sheet" value={form.optionSheet} onChange={(v) => patch({ optionSheet: v })} />
          <div className="field">
            <label>Knock back</label>
            <select value={isGenuineKnockback ? 'Yes' : 'No'} disabled>
              <option>{isGenuineKnockback ? 'Yes' : 'No'}</option>
            </select>
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              Set automatically — only a No Sale entry with a Qualified lead counts as a knock-back.
            </div>
          </div>
          {!isSaleMade && (
            <SelectField
              label={isGenuineKnockback ? 'Reason for knock back *' : 'Reason for knock back'}
              value={form.knockbackReasonId}
              onChange={(v) => patch({ knockbackReasonId: v })}
              options={settings.lists.knockback_reason}
              invalid={invalidFields.has('knockbackReasonId')}
            />
          )}
        </div>
      )}

      {isCallBack && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <SelectField label="Reason for call back" value={form.callBackReasonId} onChange={(v) => patch({ callBackReasonId: v })} options={settings.lists.callback_reason} />
        </div>
      )}

      {isPendingCancellation && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <SelectField
            label="Reason"
            value={form.pendingCancellationReasonId}
            onChange={(v) => patch({ pendingCancellationReasonId: v })}
            options={settings.lists.pending_cancellation_reason}
          />
        </div>
      )}

      {isSaleMade && (
        <div className="panel" style={{ padding: 16, marginTop: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>How was the job completed?</div>
          <div className="grid-form">
            <SelectField label="Work completion" value={form.workCompletion} onChange={(v) => patch({ workCompletion: v })} options={WORK_COMPLETION_OPTIONS} />
            {showInstallFields && (
              <SelectField
                label="Install technician"
                value={form.installTechnicianId}
                onChange={(v) => patch({ installTechnicianId: v })}
                options={settings.activeTechniciansFor(form.installTechnicianId)}
              />
            )}
            {showInstallFields && <DateField label="Install date" value={form.installDate} onChange={(v) => patch({ installDate: v })} />}
          </div>
          {showInstallFields && (
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 8 }}>
              The sale still counts against the technician above — this just records who installed it and when.
            </div>
          )}
        </div>
      )}

      {(isSaleMade || isExistingJob) && (
        <div className="panel" style={{ padding: 16, marginTop: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Invoice — this is what counts as the actual sale</div>
          <div className="grid-form">
            <div className="field">
              <label>Invoice number</label>
              <input className="mono" value={form.invoiceNumber} onChange={(e) => patch({ invoiceNumber: e.target.value })} />
            </div>
            <DateField label="Invoice creation date" value={form.invoiceDate} onChange={(v) => patch({ invoiceDate: v })} />
            <NumberField label="Sale value (ex GST) ($)" value={form.saleValueExGst} onChange={(v) => patch({ saleValueExGst: v })} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 8 }}>
            Bonus and sales reporting are based on this ex-GST amount and the invoice creation date — never the visit date.
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <TextAreaField
          label={isGenuineKnockback && knockbackReasonIsOther ? 'Additional comments *' : 'Additional comments'}
          value={form.comments}
          onChange={(v) => patch({ comments: v })}
          invalid={invalidFields.has('comments')}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button type="submit" className="btn btn-primary">
          {editing ? 'Update entry' : 'Save entry'}
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
