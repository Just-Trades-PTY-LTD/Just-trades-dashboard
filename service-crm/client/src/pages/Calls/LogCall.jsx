import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { nowLocalDateTime } from '../../lib/dates.js';
import { DateTimeField, SelectField, TextAreaField, Checkbox } from '../../components/Fields.jsx';
import { SuburbPicker } from '../../components/SuburbPicker.jsx';
import { JobLookupBox } from '../../components/JobLookupBox.jsx';
import { useJobLookup } from '../../lib/useLookup.js';

const CALL_TYPES = ['Lead', 'Not lead', 'Quote approved', 'Call back', 'Cancellation'];
const CANCELLATION_TYPES = ['New job cancellation', 'Pending job cancellation'];
const DIRECTIONS = ['Inbound', 'Outbound'];

function emptyForm() {
  return {
    callAt: nowLocalDateTime(),
    direction: 'Inbound',
    handledByUserId: '',
    callType: 'Lead',
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
  const settings = useSettings();
  const [form, setForm] = useState(emptyForm());

  useEffect(() => {
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
      setForm(emptyForm());
    }
  }, [editing]);

  function patch(p) {
    setForm((f) => ({ ...f, ...p }));
  }

  function resetForm() {
    setForm(emptyForm());
  }

  async function handleSubmit(e) {
    e.preventDefault();
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
    }
  }

  const showTrade = form.callType === 'Lead' || form.callType === 'Not lead';
  const showLeadSource = form.callType === 'Lead';
  const showBooked = form.callType === 'Lead';
  const showNotBookedReason = showBooked && form.booked === 'No';
  const showCancellationType = form.callType === 'Cancellation';
  const showCallBackReason = form.callType === 'Call back';
  const showJobNumber = ['Quote approved', 'Call back', 'Cancellation'].includes(form.callType) || (form.callType === 'Lead' && form.booked === 'Yes');
  const showJobLookup = ['Quote approved', 'Call back', 'Cancellation'].includes(form.callType);

  const lookupMode = form.callType === 'Quote approved' ? 'sale' : 'job';
  const lookupResult = useJobLookup(showJobLookup ? form.jobNumber : '', lookupMode);

  const cancellationReasonList =
    form.cancellationType === 'New job cancellation'
      ? settings.lists.new_job_cancellation_reason
      : form.cancellationType === 'Pending job cancellation'
      ? settings.lists.pending_job_cancellation_reason
      : [];

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
        <SelectField label="Direction" value={form.direction} onChange={(v) => patch({ direction: v })} options={DIRECTIONS} placeholder="" />
        <SelectField label="Handled by" value={form.handledByUserId} onChange={(v) => patch({ handledByUserId: v })} options={settings.staff} />
        <DateTimeField label="Date & time" value={form.callAt} onChange={(v) => patch({ callAt: v })} />
      </div>

      <div className="grid-form" style={{ marginTop: 14 }}>
        <SelectField
          label="Call type"
          value={form.callType}
          onChange={(v) =>
            patch({ callType: v, booked: '', notBookedReasonId: '', cancellationType: '', cancellationReasonId: '', callBackReasonId: '' })
          }
          options={CALL_TYPES}
          placeholder=""
        />
        {showBooked && <SelectField label="Booked?" value={form.booked} onChange={(v) => patch({ booked: v })} options={['Yes', 'No']} />}
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

      {form.callType === 'Cancellation' && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
          "New job cancellation" = a booked job cancelled before the technician attended. "Pending job cancellation" = the job was still
          pending when the customer cancelled it — for a job that was already <strong>sold and invoiced</strong> being
          cancelled/refunded, use Pending Cancellation on the Technician &amp; Sales page instead.
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
        <button type="submit" className="btn btn-primary">
          {editing ? 'Update call' : 'Save call'}
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
