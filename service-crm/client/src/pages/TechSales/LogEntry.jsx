import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useJobLookup } from '../../lib/useLookup.js';
import { todayLocalDate, nowLocalDateTime } from '../../lib/dates.js';
import { DateField, NumberField, SelectField, TextAreaField, YesNoField, Checkbox } from '../../components/Fields.jsx';
import { JobLookupBox } from '../../components/JobLookupBox.jsx';
import { SuburbPicker } from '../../components/SuburbPicker.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';
import { arofloAutoFill, arofloSuburbSuggestion, arofloCommentsSuggestion } from '../../lib/arofloFill.js';
import { prefillStep, revertPrefill, DIFFERENT_DAY } from '../../lib/arofloPrefill.js';
import { prefillConfirmation, invoiceChoices, scheduleApplied, attendingTechnicianApplied, hasActivity } from '../../lib/arofloDisplay.js';
import { leadCallStatus } from '../../lib/leadCallStatus.js';
import { nextLookupFill } from '../../lib/lookupFill.js';
import { changeLead, switchNewJobKind, hasEnteredDetails, confirmMessage, NA } from '../../lib/leadTransitions.js';

const ENTRY_TYPES = [
  ['new_job_no_sale', 'New Job — No Sale'],
  ['new_job_sale_made', 'New Job — Sale Made'],
  ['quote_approved_later', 'Existing Job — Quote Approved Later'],
  ['existing_job_upsell', 'Existing Job — Upsell'],
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
    newJobNumber: '',
    tradeId: '',
    jobTypeId: '',
    // A Sale Made job is always Qualified (enforced by the server too).
    lead: kind === 'new_job_sale_made' ? 'Qualified' : '',
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
    suburb: '',
    // Existing Job — Upsell only: this Job Number/Invoice Number are a plain
    // text reference to a job/invoice that predates the CRM, not expected to
    // match an existing record — see validate()/handleSubmit() below.
    predatesCrm: false,
    // Quote Follow-up trial — never part of the job itself (no jobs.* column
    // for either of these); on save, a brand-new genuine knock-back fires a
    // second, independent POST /follow-ups call — see handleSubmit() below.
    followUpRequired: false,
    followUpDueDate: '',
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
    newJobNumber: entry.newJobNumber || '',
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
    suburb: entry.suburb || '',
    // Derived from whether this entry already has a linked job (jobId is
    // only ever returned for a sale-based entry — see saleToEntry()) —
    // never stored as its own field, so editing an existing entry always
    // reflects what it actually is rather than a separately-saved flag that
    // could drift from it.
    predatesCrm: entry.kind === 'existing_job_upsell' && !entry.jobId,
    // The "Follow-up required" checkbox is creation-only (see below) —
    // editing an existing knock-back uses Job History's own "Add/View
    // follow-up" affordance instead.
    followUpRequired: false,
    followUpDueDate: '',
  };
}

// Read-only "AroFlo activity" — time logged on the job and visits booked,
// in Adelaide time. Display only: there's deliberately no "Use this" here.
// One job can have several technicians across several days (e.g. a service
// visit plus a separate install), so which entry is "the" visit or "the"
// technician is left to staff, and AroFlo's own short names ("Ryan S") can't
// be matched to the CRM's technicians safely.
function ActivityTable({ title, rows, emptyText }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {rows === null ? (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>AroFlo didn't return this — check AroFlo directly if needed.</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{emptyText}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Technician (AroFlo)</th>
              <th>Date</th>
              <th>Time</th>
              <th>Hours</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.date}-${r.start}-${r.technician}-${i}`}>
                <td>
                  {r.technician || '—'}
                  {r.position && <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{r.position}</div>}
                </td>
                <td className="mono">{r.date || '—'}</td>
                <td className="mono">{r.start ? `${r.start}${r.finish ? `–${r.finish}` : ''}` : '—'}</td>
                <td className="mono">{r.hours ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// AroFlo's logged time and booked visits: read-only reference behind a
// collapsed link (collapsed by default), shown only when AroFlo returned
// something. Nothing in here can change the form — staff still choose the
// visit/credited Technician themselves (it's never filled from AroFlo).
function ArofloActivity({ activity }) {
  const [open, setOpen] = useState(false);
  // Every new lookup starts collapsed again.
  useEffect(() => setOpen(false), [activity]);
  if (!hasActivity(activity)) return null;
  return (
    <div style={{ marginTop: 10 }} data-testid="aroflo-activity">
      <button className="btn btn-sm" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide AroFlo visits and time' : 'Show AroFlo visits and time'}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
            For reference only — nothing here is filled in or saved. Times are Adelaide time.
          </div>
          {activity.labour?.length > 0 && <ActivityTable title="Time logged in AroFlo" rows={activity.labour} />}
          {activity.visits?.length > 0 && <ActivityTable title="Visits booked in AroFlo" rows={activity.visits} />}
        </div>
      )}
    </div>
  );
}

// One AroFlo value staff can choose to apply — only ever shown when it isn't
// already in the form.
function ArofloChoice({ children, buttonLabel = 'Use this', onUse }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <span>{children}</span>
      <button className="btn btn-sm" type="button" onClick={onUse}>
        {buttonLabel}
      </button>
    </div>
  );
}

export default function LogEntry({ editing, onSaved, onCancelEdit, setNotice }) {
  const settings = useSettings();
  const [form, setForm] = useState(emptyForm());
  const [invalidFields, setInvalidFields] = useState(new Set());
  // New Job only: the last "Look up in AroFlo" result, and what Suburb held
  // immediately before it was applied — purely so a conflicting call-based
  // suburb can still be shown for reference, never to revert the field.
  const [arofloResult, setArofloResult] = useState(null);
  const [arofloLoading, setArofloLoading] = useState(false);
  const [priorSuburb, setPriorSuburb] = useState('');
  // True while a save is in flight. The ref blocks a second submit straight
  // away (a fast double-click lands before React re-renders the disabled
  // button); the state greys the button out.
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // The form as of the latest render, and a counter bumped whenever an
  // in-flight AroFlo lookup should no longer apply — so a slow lookup fills
  // against what's on screen when it returns, not what was there when the
  // button was clicked, and never lands on a form that has since moved on.
  const formRef = useRef(form);
  formRef.current = form;
  const arofloSeq = useRef(0);
  // What each Job Number lookup last auto-filled (see lib/lookupFill.js), so
  // correcting the Job Number takes back the old job's values.
  const lookupFills = useRef({});
  // New, unsaved New Job entries only: what the AroFlo lookup filled
  // ({ field: { value, prior } }), the Job Number it was for, and its notes
  // and suggestions — see lib/arofloPrefill.js.
  const arofloFilled = useRef({ jn: '', fields: {} });
  // The Job Number an AroFlo lookup is running for right now ('' if none) —
  // a ref, so a Job Number typed while a slow lookup runs is never blocked
  // by state that hasn't re-rendered yet.
  const arofloInFlight = useRef('');
  const [arofloPlan, setArofloPlan] = useState(null);
  // Other entry types (and every new entry's lookup): which blank fields
  // arofloAutoFill() put into the form, so the confirmation can name them.
  const [arofloAutoFilled, setArofloAutoFilled] = useState([]);
  function applyLookupFill(source, wanted) {
    const { patch: changes, filled } = nextLookupFill(formRef.current, lookupFills.current[source], wanted);
    lookupFills.current[source] = filled;
    if (Object.keys(changes).length) patch(changes);
  }

  useEffect(() => {
    arofloSeq.current += 1;
    lookupFills.current = {};
    setArofloLoading(false);
    setForm(editing ? fromEntry(editing) : emptyForm());
    setInvalidFields(new Set());
    setArofloResult(null);
    setPriorSuburb('');
    arofloFilled.current = { jn: '', fields: {} };
    arofloInFlight.current = '';
    setArofloPlan(null);
    setArofloAutoFilled([]);
  }, [editing]);

  function patch(p) {
    setForm((f) => ({ ...f, ...p }));
  }

  const isNewJob = form.kind === 'new_job_no_sale' || form.kind === 'new_job_sale_made';
  const isSaleMade = form.kind === 'new_job_sale_made';
  const isExistingJob = form.kind === 'quote_approved_later';
  const isUpsell = form.kind === 'existing_job_upsell';
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
  const isNotQualifiedNoSale = form.kind === 'new_job_no_sale' && form.lead === 'Not Qualified';
  const legacySaleMadeNotQualified = !!editing && isSaleMade && editing.lead === 'Not Qualified';
  // Same rule as the server (lib/leadRules.js): Lead can't be changed on a
  // job with an open follow-up or a Quote Approved Later / Converted Later
  // link — those need resolving separately first.
  const leadBlockedBy = (!!editing && !isSaleMade && editing.leadChangeBlockedBy) || [];
  const knockbackDisplay = isNotQualifiedNoSale ? NA : isGenuineKnockback ? 'Yes' : 'No';
  const isYesNo = (v) => v === 'Yes' || v === 'No';

  // Not Qualified No Sale -> sheets N/A, no knock-back reason; back to
  // Qualified -> normal selection. Confirms first if Yes/No answers, a
  // reason or a follow-up reminder would be replaced (lib/leadTransitions.js).
  function handleLeadChange(v) {
    const { next, lost } = changeLead(form, v, { reasonName: knockbackReason?.name });
    if (lost.length && !window.confirm(confirmMessage('Changing Lead to Not Qualified will make these changes:', lost))) return;
    setForm(next);
  }

  const jobLookupMode = isPendingCancellation ? 'sale' : 'job';
  const showJobLookup = isExistingJob || isUpsell || isPendingCancellation;
  const lookupResult = useJobLookup(showJobLookup ? form.jobNumber : '', jobLookupMode);
  // Call Back's own Original Job Number lookup — kept separate from the
  // generic one above (rather than folded into showJobLookup) because Call
  // Back gets its own dedicated field block below, matching Quote Approved
  // Later/Upsell's own pattern.
  const callBackJobLookup = useJobLookup(isCallBack ? form.jobNumber : '', 'job');
  // The existing invoice already on record for this Job Number — shown
  // alongside the Invoice Number field below purely as a reference (what's
  // already on file for this job), never used to block submission itself —
  // the server is the authority on whether the typed Invoice Number actually
  // matches (see findSaleForInvoice in routes/techSales.js).
  const upsellInvoiceLookup = useJobLookup(isUpsell ? form.jobNumber : '', 'sale');
  // A brand-new job entered under a Job Number that already belongs to
  // another active job — surfaced as a warning as soon as it's typed, and
  // blocked at submit (see validate() below) rather than silently creating a
  // second, conflicting job on the same JN. Only relevant when creating —
  // editing an existing job will always "match" its own record, which isn't
  // a duplicate.
  const newJobDuplicateCheck = useJobLookup(isNewJob && !editing ? form.jobNumber : '', 'job');

  // The earliest Calls & Contacts record sharing this Job Number — the
  // linked/original booking, never a later, unrelated contact — used to
  // auto-populate a brand-new job's Suburb, Trade and Job Type below (staff
  // already select Trade/Job Type when logging the call — an exact
  // reference to this CRM's own lists, never a guess). Runs on both create
  // and edit (like the autofill effect just below), gated only by each
  // field still being blank, so it never overwrites a value already set.
  const callLookup = useJobLookup(isNewJob ? form.jobNumber : '', 'call');

  // Silently autofill the credited technician, trade and job type from the
  // matched job/sale, the way the prototype's lookup effect did — filled in
  // automatically where possible, but always left editable in case the match
  // needs correcting.
  useEffect(() => {
    const r = lookupResult?.found ? lookupResult : null;
    let wanted = {};
    if (r && isExistingJob) {
      wanted = { creditedTechnicianId: r.technicianId, tradeId: r.tradeId, jobTypeId: r.jobTypeId, suburb: r.suburb };
    } else if (r && isUpsell) {
      // Deliberately never auto-fills Credited Technician — that's who made
      // the upsell, which is often (the whole point of this entry type) a
      // different technician than the one who originally attended the job.
      wanted = { tradeId: r.tradeId, jobTypeId: r.jobTypeId, suburb: r.suburb };
    } else if (r && isPendingCancellation) {
      wanted = { creditedTechnicianId: r.creditedTechnicianId };
    }
    applyLookupFill('job', wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupResult]);

  // Call Back's own Credited (original work) Technician: who actually
  // completed the original work, not necessarily who's credited with the
  // sale — the matched job's own attending technician normally, or its
  // separate Install Technician when that job's own Work Completion says the
  // work happened on a different day (falling back to the attending
  // technician if no install technician was ever recorded). Trade/Job Type
  // auto-fill the same way every other entry type's does. Still only ever
  // fills a currently-blank field, and still fully editable afterwards.
  useEffect(() => {
    const r = isCallBack && callBackJobLookup?.found ? callBackJobLookup : null;
    let wanted = {};
    if (r) {
      const completedOnDifferentDay = r.workCompletion === 'Install scheduled — different day';
      const workTechnicianId = (completedOnDifferentDay && r.installTechnicianId) || r.technicianId;
      wanted = { creditedTechnicianId: workTechnicianId, tradeId: r.tradeId, jobTypeId: r.jobTypeId };
    }
    applyLookupFill('callBack', wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callBackJobLookup, isCallBack]);

  // Suburb/Trade/Job Type: each auto-populated independently from the
  // matched call above, only when there's actually a value on it to use and
  // only into a field that's still blank — a matching call missing one of
  // these (or no matching call at all) leaves that field blank for manual
  // selection instead, exactly as if nothing had matched. Never overwrites a
  // value already set, whether that came from the user or another autofill.
  useEffect(() => {
    const r = isNewJob && callLookup?.found ? callLookup : null;
    applyLookupFill('call', r ? { suburb: r.suburb, tradeId: r.tradeId, jobTypeId: r.jobTypeId } : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callLookup, isNewJob]);

  // Quote Follow-up trial — default the due date once, the first time the
  // checkbox is checked for this entry; never overwrites a value the staff
  // member has already set or edited.
  useEffect(() => {
    if (!form.followUpRequired || !form.visitDate || form.followUpDueDate) return;
    api.followUps
      .defaultDueDate(form.visitDate)
      .then(({ dueDate }) => patch({ followUpDueDate: dueDate }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.followUpRequired, form.visitDate]);

  // Switching between No Sale and Sale Made keeps the shared details; any
  // other switch starts the form again. Either way, anything staff entered
  // that would be cleared is listed and confirmed first. `force` is only
  // for resetting the form after a successful save.
  function changeEntryType(kind, { force = false } = {}) {
    if (!force) {
      const sw = switchNewJobKind(form, kind, { reasonName: knockbackReason?.name, emptyForm });
      if (sw) {
        if (sw.lost.length && !window.confirm(confirmMessage('Changing the entry type will make these changes:', sw.lost))) return;
        setForm(sw.next);
        setInvalidFields(new Set());
        return;
      }
      if (kind !== form.kind && hasEnteredDetails(form, emptyForm) && !window.confirm('Changing the entry type will clear the details entered so far. Continue?')) return;
    }
    arofloSeq.current += 1;
    lookupFills.current = {};
    setArofloLoading(false);
    setForm(emptyForm(kind));
    setInvalidFields(new Set());
    setArofloResult(null);
    setPriorSuburb('');
    arofloFilled.current = { jn: '', fields: {} };
    arofloInFlight.current = '';
    setArofloPlan(null);
    setArofloAutoFilled([]);
  }

  // New Job, Existing Job — Upsell, and Call Back — a deliberate, optional
  // lookup, always against whichever Job Number actually corresponds to an
  // AroFlo task for that entry type (the original JN for New Job/Upsell, the
  // separate New Callback JN for Call Back, since that's the task created
  // once the callback attendance is booked). Suburb (where the entry type
  // has one) is applied immediately on a confident match — AroFlo's own job
  // address is what actually sends a technician to a location, making it
  // the more trustworthy of the two sources when it disagrees with a
  // call/job-based guess already on the field. Whatever Suburb held before
  // is kept (priorSuburb) purely to show as a reference if it conflicts,
  // never to revert the field. Comments fills in only if still blank.
  // When editing an entry that's already saved, none of that is applied —
  // Suburb and Comments are offered as "Use this" suggestions instead (see
  // lib/arofloFill.js), so a lookup can never quietly change a saved record.
  // Everything else (Task Type, invoices, a Pending job's scheduled visit)
  // is shown for the user to apply themselves — never silently attached.
  async function runArofloLookup(jobNumber, { applySuburb } = {}) {
    const jn = (jobNumber || '').trim();
    if (!jn) return;
    const seq = ++arofloSeq.current;
    const kindAtStart = form.kind;
    arofloInFlight.current = jn;
    setArofloLoading(true);
    setArofloResult(null);
    setArofloAutoFilled([]);
    // Still the latest lookup, for the same entry type and a Job Number
    // field that still holds this number? Otherwise its answer is dropped.
    const stillApplies = () => {
      const current = formRef.current;
      return (
        seq === arofloSeq.current &&
        current.kind === kindAtStart &&
        [current.jobNumber, current.newJobNumber].some((v) => (v || '').trim() === jn)
      );
    };
    try {
      const result = await api.aroflo.lookup(jn, { activity: true });
      if (!stillApplies()) return;
      setArofloResult(result);
      if (!editing && (kindAtStart === 'new_job_no_sale' || kindAtStart === 'new_job_sale_made')) {
        applyNewJobPrefill(jn, result);
        return;
      }
      const current = formRef.current;
      const fill = arofloAutoFill({ result, form: current, applySuburb, editing: !!editing });
      if (fill.suburb) setPriorSuburb(current.suburb);
      setArofloAutoFilled(Object.keys(fill));
      // Re-checked inside the update against the very latest form, so text
      // typed into Comments while the lookup was running is never replaced.
      setForm((f) => ({ ...f, ...arofloAutoFill({ result, form: f, applySuburb, editing: !!editing }) }));
    } catch (err) {
      if (!stillApplies()) return;
      setArofloResult({ found: false, message: err.message || 'AroFlo lookup failed — you can still enter this job manually.' });
      if (!editing && (kindAtStart === 'new_job_no_sale' || kindAtStart === 'new_job_sale_made')) applyNewJobPrefill(jn, { found: false });
    } finally {
      if (seq === arofloSeq.current) {
        setArofloLoading(false);
        arofloInFlight.current = '';
      }
    }
  }

  // New, unsaved New Job entry: fill blank fields from one reliable AroFlo
  // match (lib/arofloPrefill.js), first taking back anything an earlier
  // lookup filled that's still showing. Form only — never saved here.
  function applyNewJobPrefill(jn, result) {
    const [date, time] = nowLocalDateTime().split('T');
    const { plan, patch: changes, filled } = prefillStep({
      result,
      form: formRef.current,
      previous: arofloFilled.current.fields,
      now: { date, time },
      trades: settings.trades,
      technicians: settings.technicians,
      defaults: { invoiceDate: emptyForm().invoiceDate },
    });
    arofloFilled.current = { jn, fields: filled };
    setArofloPlan({ ...plan, filled: Object.keys(filled) });
    if (Object.keys(changes).length) setForm((f) => ({ ...f, ...changes }));
  }

  // The New Job Number field changed: drop the previous lookup's
  // suggestions and take back what it filled (only where still showing).
  function changeNewJobNumber(value) {
    const prev = arofloFilled.current;
    const inFlight = arofloInFlight.current;
    if (!editing && (prev.jn || arofloResult || inFlight) && value.trim() !== (prev.jn || inFlight)) {
      // Any lookup still running is for the old number: its answer is dropped.
      arofloSeq.current += 1;
      arofloInFlight.current = '';
      setArofloLoading(false);
      const undo = revertPrefill(formRef.current, prev.fields);
      arofloFilled.current = { jn: '', fields: {} };
      setArofloResult(null);
      setArofloPlan(null);
      setArofloAutoFilled([]);
      patch({ ...undo, jobNumber: value });
      return;
    }
    patch({ jobNumber: value });
  }

  // Leaving the Job Number field on a new entry runs the lookup once for
  // that number (the button stays for a manual retry).
  function autoLookupNewJob() {
    const jn = (formRef.current.jobNumber || '').trim();
    if (editing || !jn || arofloInFlight.current === jn) return;
    if (arofloFilled.current.jn === jn && arofloResult) return;
    runArofloLookup(jn);
  }

  function applyArofloSuggestion(values) {
    patch(values);
  }

  // Editing only: staff chose AroFlo's suburb/description over what's saved.
  const suburbSuggestion = arofloSuburbSuggestion({ result: arofloResult, form, editing: !!editing });
  const commentsSuggestion = arofloCommentsSuggestion({ result: arofloResult, form, editing: !!editing });
  // A new Existing Job / Upsell / Call Back entry whose suburb already holds
  // something different from AroFlo's job address: offered, never applied.
  const suburbChoice =
    suburbSuggestion ||
    (!editing && !isNewJob && arofloResult?.found && arofloResult.suburb && form.suburb && form.suburb !== arofloResult.suburb
      ? arofloResult.suburb
      : null);
  const arofloView = (() => {
    const view = { confirmation: null, nothingAdded: false, matchesEntry: false, notes: [], suggestions: [], invoices: [], invoiceHeading: null, schedule: false, callBackTechnician: null, callbackConfirmed: false };
    if (!arofloResult?.found) return view;
    const newJobPlan = isNewJob && !editing ? arofloPlan : null;
    if (!editing) view.confirmation = prefillConfirmation(newJobPlan ? newJobPlan.filled : arofloAutoFilled);
    if (newJobPlan) {
      view.notes = newJobPlan.notes;
      view.suggestions = newJobPlan.suggestions;
    } else if ((isNewJob || isExistingJob || isUpsell) && !arofloResult.suburb && arofloResult.addressForReference) {
      // No confident suburb: AroFlo's job address, read-only, so staff can
      // check the Suburb themselves (a new New Job entry gets this in its
      // prefill note instead).
      view.notes = [`No single confident suburb match from AroFlo's job address (${arofloResult.addressForReference}) — please check the suburb.`];
    }
    if (isSaleMade || isExistingJob) {
      view.invoices = invoiceChoices(arofloResult, form);
      const total = arofloResult.invoices?.length || 0;
      // A new New Job's own note already says how many invoices there are.
      if (!(newJobPlan && total > 1)) {
        view.invoiceHeading =
          view.invoices.length > 1 ? "Choose one of AroFlo's invoices, or enter it manually:" : editing || form.invoiceNumber ? "AroFlo's invoice for this job (not the one in this entry):" : "AroFlo's invoice for this job:";
      }
    }
    // A Call Back entry whose AroFlo task type is also Call Back: a simple
    // confirmation. The entry type is never changed either way.
    view.callbackConfirmed = isCallBack && arofloResult.taskTypeMatch?.kind === 'callback';
    view.schedule = isSaleMade && !!arofloResult.scheduled && !scheduleApplied(arofloResult.scheduled, form, DIFFERENT_DAY);
    if (isCallBack && arofloResult.scheduled) {
      if (!arofloResult.scheduled.matchedTechnicianId) view.callBackTechnician = 'unmatched';
      else if (!attendingTechnicianApplied(arofloResult.scheduled, form)) view.callBackTechnician = 'choice';
    }
    const anythingToChoose =
      view.notes.length || view.suggestions.length || suburbChoice || commentsSuggestion || view.invoices.length || view.schedule || view.callBackTechnician;
    if (editing) view.matchesEntry = !anythingToChoose;
    else if (newJobPlan) view.nothingAdded = !view.confirmation;
    else view.nothingAdded = !view.confirmation && !anythingToChoose;
    return view;
  })();

  function applyArofloSuburbSuggestion() {
    setPriorSuburb(form.suburb);
    patch({ suburb: suburbSuggestion });
  }

  function applyArofloInvoice(inv) {
    patch({ invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate || form.invoiceDate, saleValueExGst: inv.saleValueExGst });
  }

  function applyArofloSchedule() {
    if (!arofloResult?.scheduled) return;
    patch({
      workCompletion: 'Install scheduled — different day',
      installTechnicianId: arofloResult.scheduled.matchedTechnicianId || form.installTechnicianId,
      installDate: arofloResult.scheduled.date || form.installDate,
    });
  }

  // Call Back only: suggests its own Attending Technician from AroFlo's
  // scheduled resource — never Credited Technician, which already carries a
  // different, deliberate meaning (who actually completed the original
  // work) and is auto-filled from the original job elsewhere. Only ever
  // offered (the button only renders) when matchedTechnicianId is a single
  // confident match — an ambiguous or missing match leaves this manual.
  function applyArofloAttendingTechnician() {
    if (!arofloResult?.scheduled?.matchedTechnicianId) return;
    patch({ technicianId: arofloResult.scheduled.matchedTechnicianId });
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
      if (isGenuineKnockback && form.followUpRequired && !form.followUpDueDate) {
        missing.push('Follow-up due date');
        fields.add('followUpDueDate');
      }
    } else if (isExistingJob) {
      // Both JNs are mandatory only on a brand-new Quote Approved Later
      // entry — editing an existing one (including a legacy record saved
      // with only one JN) is never blocked by this, per handleSubmit()
      // below.
      if (!form.jobNumber || !form.jobNumber.trim()) {
        missing.push('Original Job Number');
        fields.add('jobNumber');
      }
      if (!form.newJobNumber || !form.newJobNumber.trim()) {
        missing.push('New Job Number');
        fields.add('newJobNumber');
      }
      if (!form.creditedTechnicianId) {
        missing.push('Credited Technician');
        fields.add('creditedTechnicianId');
      }
    } else if (isUpsell) {
      if (!form.jobNumber || !form.jobNumber.trim()) {
        missing.push('Job Number');
        fields.add('jobNumber');
      }
      if (!form.invoiceNumber || !form.invoiceNumber.trim()) {
        missing.push('Invoice Number');
        fields.add('invoiceNumber');
      }
      // Credited Technician is who actually made the upsell — mandatory on
      // creation so it can never silently fall into an "Unassigned" bucket
      // in reports.
      if (!form.creditedTechnicianId) {
        missing.push('Credited Technician');
        fields.add('creditedTechnicianId');
      }
      // No matched job/invoice to auto-fill these from — the server backs
      // this same rule up (see /existing-job-upsell's own "missing2" check).
      if (form.predatesCrm) {
        if (!form.tradeId) {
          missing.push('Trade');
          fields.add('tradeId');
        }
        if (!form.invoiceDate) {
          missing.push('Invoice Date');
          fields.add('invoiceDate');
        }
      }
    } else if (isCallBack) {
      if (!form.jobNumber || !form.jobNumber.trim()) {
        missing.push('Original Job Number');
        fields.add('jobNumber');
      }
      if (!form.technicianId) {
        missing.push('Attending Technician');
        fields.add('technicianId');
      }
      // Credited Technician is what every Technician & Sales report figure
      // this entry counts towards is attributed to — mandatory on creation
      // only (see handleSubmit below), so it can never silently fall into
      // an "Unassigned" bucket in reports.
      if (!form.creditedTechnicianId) {
        missing.push('Credited Technician');
        fields.add('creditedTechnicianId');
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
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
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
          suburb: form.suburb,
        };
        res = editing ? { entry: await api.tech.updateNewJob(editing.id, body) } : await api.tech.createNewJob(body);
      } else if (isExistingJob) {
        const body = {
          jobNumber: form.jobNumber,
          newJobNumber: form.newJobNumber,
          dateLogged: form.dateLogged,
          creditedTechnicianId: form.creditedTechnicianId || null,
          tradeId: form.tradeId || null,
          jobTypeId: form.jobTypeId || null,
          invoiceNumber: form.invoiceNumber,
          invoiceDate: form.invoiceDate,
          saleValueExGst: form.saleValueExGst,
          comments: form.comments,
          suburb: form.suburb,
        };
        res = editing ? { entry: await api.tech.updateQuoteApprovedLater(editing.id, body) } : await api.tech.createQuoteApprovedLater(body);
      } else if (isUpsell) {
        const body = {
          jobNumber: form.jobNumber,
          invoiceNumber: form.invoiceNumber,
          dateLogged: form.dateLogged,
          creditedTechnicianId: form.creditedTechnicianId || null,
          tradeId: form.tradeId || null,
          jobTypeId: form.jobTypeId || null,
          invoiceDate: form.invoiceDate,
          // The ADDITIONAL upsell value ex GST only — never the full invoice
          // value again.
          saleValueExGst: form.saleValueExGst,
          suburb: form.suburb,
          comments: form.comments,
          predatesCrm: form.predatesCrm,
        };
        res = editing ? { entry: await api.tech.updateUpsell(editing.id, body) } : await api.tech.createUpsell(body);
      } else if (isCallBack) {
        const body = {
          jobNumber: form.jobNumber,
          newJobNumber: form.newJobNumber,
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

      let notice = res.notice || (editing ? 'Entry updated.' : 'Entry logged.');
      let noticeIsError = false;
      // Quote Follow-up trial — a second, independent call after the job
      // itself is already safely saved; the job is never rolled back or
      // blocked if this one fails.
      if (isNewJob && !editing && form.followUpRequired && res.entry?.id) {
        try {
          await api.followUps.create({ jobId: res.entry.id, dueDate: form.followUpDueDate });
        } catch (err) {
          notice = `${notice} However, the follow-up reminder could not be created: ${err.message}`;
          noticeIsError = true;
        }
      }
      setNotice(notice, noticeIsError);
      onSaved();
      if (!editing) changeEntryType(form.kind, { force: true });
    } catch (err) {
      setNotice(err.message, true);
    } finally {
      savingRef.current = false;
      setSaving(false);
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
        // Locked while editing: switching type resets the form, and saving
        // would then send that blank form to the other type's update with
        // this record's id — blanking it, or an unrelated record that shares
        // the id. To log it as a different type, cancel and start a new entry.
        disabled={!!editing}
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
      {isUpsell && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>
          A different technician added extra work onto a job's existing invoice. Record only the additional upsell value (ex GST) —
          never the full invoice value again. This never creates another Total/Qualified Job, Knock-back or Converted Later credit,
          and never changes the original job or technician's own figures.
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

      {isExistingJob ? (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <div className={`field${invalidFields.has('jobNumber') ? ' invalid' : ''}`}>
            <label>Original Job Number *</label>
            <input className="mono" placeholder="e.g. 10432" value={form.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} />
            <JobLookupBox jobNumber={form.jobNumber} mode={jobLookupMode} result={lookupResult} />
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              The original visit's Job Number — used to locate the original job and credit the correct technician.
            </div>
          </div>
          <div className={`field${invalidFields.has('newJobNumber') ? ' invalid' : ''}`}>
            <label>New Job Number *</label>
            <input
              className="mono"
              placeholder="e.g. 20458"
              value={form.newJobNumber}
              onChange={(e) => patch({ newJobNumber: e.target.value })}
            />
            <button
              className="btn"
              type="button"
              disabled={!form.newJobNumber.trim() || arofloLoading}
              onClick={() => runArofloLookup(form.newJobNumber, { applySuburb: true })}
              style={{ marginTop: 6, width: '100%' }}
            >
              {arofloLoading ? 'Looking up…' : 'Look up in AroFlo'}
            </button>
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              The new AroFlo Job Number created for the approved work — reference and searching only, does not link to a job or
              count as a Total/Qualified Job.
            </div>
          </div>
        </div>
      ) : isUpsell ? (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <div className={`field${invalidFields.has('jobNumber') ? ' invalid' : ''}`}>
            <label>Job Number *</label>
            <input className="mono" placeholder="e.g. 10432" value={form.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} />
            {!form.predatesCrm && (
              <button
                className="btn"
                type="button"
                disabled={!form.jobNumber.trim() || arofloLoading}
                onClick={() => runArofloLookup(form.jobNumber, { applySuburb: true })}
                style={{ marginTop: 6, width: '100%' }}
              >
                {arofloLoading ? 'Looking up…' : 'Look up in AroFlo'}
              </button>
            )}
            {!form.predatesCrm && <JobLookupBox jobNumber={form.jobNumber} mode="job" result={lookupResult} />}
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              {form.predatesCrm
                ? 'A reference only — this job predates the CRM, so no match is required.'
                : "The existing job the upsell was made on — used to locate the original job and auto-fill Trade/Job Type/Suburb below."}
            </div>
          </div>
          <div className={`field${invalidFields.has('invoiceNumber') ? ' invalid' : ''}`}>
            <label>Invoice Number *</label>
            <input className="mono" value={form.invoiceNumber} onChange={(e) => patch({ invoiceNumber: e.target.value })} />
            {!form.predatesCrm && <JobLookupBox jobNumber={form.jobNumber} mode="sale" result={upsellInvoiceLookup} />}
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              {form.predatesCrm
                ? 'A reference only — no matching invoice is required.'
                : 'The existing invoice the upsell has been added to — must already be on record for this Job Number.'}
            </div>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <Checkbox
              label="This job predates the CRM (original job/invoice not on record)"
              checked={form.predatesCrm}
              onChange={(v) => patch({ predatesCrm: v })}
            />
            {form.predatesCrm && (
              <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 6 }}>
                Trade, Invoice Date and Upsell value below are required — there's no original job to auto-fill them from. The
                original job and invoice are never created or counted as a Total/Qualified Job or a Sale; only this upsell's own
                value is credited to the technician below.
              </div>
            )}
          </div>
        </div>
      ) : isCallBack ? (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <div className={`field${invalidFields.has('jobNumber') ? ' invalid' : ''}`}>
            <label>Original Job Number *</label>
            <input className="mono" placeholder="e.g. 10432" value={form.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} />
            <JobLookupBox jobNumber={form.jobNumber} mode="job" result={callBackJobLookup} />
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              The job that caused this callback — used to auto-fill Trade/Job Type/Credited Technician below. Still allowed to save
              even if no match is found yet (e.g. the original job hasn't been logged here).
            </div>
          </div>
          <div className="field">
            <label>New Callback Job Number</label>
            <input
              className="mono"
              placeholder="e.g. 20458"
              value={form.newJobNumber}
              onChange={(e) => patch({ newJobNumber: e.target.value })}
            />
            <button
              className="btn"
              type="button"
              disabled={!form.newJobNumber.trim() || arofloLoading}
              onClick={() => runArofloLookup(form.newJobNumber)}
              style={{ marginTop: 6, width: '100%' }}
            >
              {arofloLoading ? 'Looking up…' : 'Look up in AroFlo'}
            </button>
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              The new AroFlo Job Number created once the callback attendance is booked — leave blank if not known yet. Reference and
              searching only, does not link to a job or count as a Total/Qualified Job.
            </div>
          </div>
        </div>
      ) : (
        showJobLookup && (
          <div className="grid-form" style={{ marginTop: 14 }}>
            <div className={`field${invalidFields.has('jobNumber') ? ' invalid' : ''}`}>
              <label>Job number (JN) *</label>
              <input className="mono" placeholder="e.g. 10432" value={form.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} />
              <JobLookupBox jobNumber={form.jobNumber} mode={jobLookupMode} result={lookupResult} />
            </div>
          </div>
        )
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
            <input
              className="mono"
              placeholder="e.g. 10432"
              value={form.jobNumber}
              onChange={(e) => changeNewJobNumber(e.target.value)}
              onBlur={autoLookupNewJob}
            />
            <button
              className="btn"
              type="button"
              disabled={!form.jobNumber.trim() || arofloLoading}
              onClick={() => runArofloLookup(form.jobNumber, { applySuburb: true })}
              style={{ marginTop: 6, width: '100%' }}
            >
              {arofloLoading ? 'Looking up…' : 'Look up in AroFlo'}
            </button>
            {newJobDuplicateCheck?.found && (
              <div className="lookup-box lookup-missing">
                Job Number {form.jobNumber} already exists (visit {newJobDuplicateCheck.visitDate}
                {newJobDuplicateCheck.trade ? ` — ${newJobDuplicateCheck.trade}` : ''}). If this is a follow-up on that job, use "Existing
                Job — Quote Approved Later" or "Call Back" instead.
              </div>
            )}
            {(() => {
              // Where this job's Lead Source will come from in the reports —
              // a heads-up only, never blocks saving.
              const status = leadCallStatus(form.jobNumber, callLookup);
              return status && <div className={`lookup-box lookup-${status.tone}`}>{status.text}</div>;
            })()}
          </div>
          <div className="field">
            <SuburbPicker value={form.suburb} onChange={(v) => patch({ suburb: v })} />
            {(!arofloResult?.suburb) && callLookup?.found && callLookup.suburb && form.suburb === callLookup.suburb && (
              <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
                Auto-filled from the matching Calls &amp; Contacts record for this Job Number — still editable if it needs correcting.
              </div>
            )}
          </div>
        </div>
      )}

      {(isNewJob || isExistingJob || isUpsell || isCallBack) && arofloResult && (
        <div className="panel" style={{ padding: 16, marginTop: 14, background: 'var(--surface-2)' }} data-testid="aroflo-box">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>AroFlo</div>
          {!arofloResult.found ? (
            <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>{arofloResult.message}</div>
          ) : (
            <div style={{ fontSize: 12.5 }}>
              {/* New entry: one confirmation naming the fields AroFlo filled
                  (names only — the values are in the form, still editable). */}
              {arofloView.confirmation && (
                <div className="lookup-box lookup-found" style={{ marginTop: 0 }} data-testid="aroflo-confirmation">
                  ✓ {arofloView.confirmation}
                </div>
              )}
              {arofloView.callbackConfirmed && (
                <div className="lookup-box lookup-found" style={{ marginTop: 0 }} data-testid="aroflo-callback-confirmed">
                  ✓ AroFlo also identifies this job as a Call Back.
                </div>
              )}
              {arofloView.nothingAdded && !arofloView.callbackConfirmed && <div>AroFlo found this job, but nothing could be added automatically.</div>}
              {arofloView.matchesEntry && <div>AroFlo matches this entry — nothing to change.</div>}
              {arofloView.notes.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} data-testid="aroflo-notes">
                  {arofloView.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {arofloView.suggestions.map((sug) => (
                <ArofloChoice key={sug.label} onUse={() => applyArofloSuggestion(sug.values)}>
                  AroFlo suggests <strong>{sug.label}</strong> — you've entered something different.
                </ArofloChoice>
              ))}
              {suburbChoice && (
                <ArofloChoice onUse={applyArofloSuburbSuggestion}>
                  Suburb: AroFlo's job address is <strong>{suburbChoice}</strong>
                  {form.suburb ? <>; {editing ? 'this entry is saved as' : "you've entered"} {form.suburb}.</> : '.'}
                </ArofloChoice>
              )}
              {commentsSuggestion && (
                <ArofloChoice buttonLabel="Use AroFlo's description" onUse={() => patch({ comments: commentsSuggestion })}>
                  AroFlo has a job description for this job — not applied.
                </ArofloChoice>
              )}
              {arofloView.invoices.length > 0 && (
                <div style={{ marginTop: 8 }} data-testid="aroflo-invoices">
                  {arofloView.invoiceHeading && <div style={{ fontWeight: 600 }}>{arofloView.invoiceHeading}</div>}
                  {arofloView.invoices.map((inv) => (
                    <ArofloChoice key={inv.invoiceNumber} onUse={() => applyArofloInvoice(inv)}>
                      <span className="mono">{inv.invoiceNumber}</span>
                      {inv.invoiceDate ? <> · <span className="mono">{inv.invoiceDate}</span></> : null}
                      {inv.saleValueExGst !== null && inv.saleValueExGst !== undefined ? <> · ${Number(inv.saleValueExGst).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ex GST</> : null}
                    </ArofloChoice>
                  ))}
                </div>
              )}
              {arofloView.schedule && (
                <ArofloChoice buttonLabel="Use for install technician/date" onUse={applyArofloSchedule}>
                  AroFlo shows a scheduled return visit: <strong>{arofloResult.scheduled.technicianName}</strong> on{' '}
                  <strong>{arofloResult.scheduled.date}</strong>
                  {!arofloResult.scheduled.matchedTechnicianId && ' (no confident match to a technician on file — select one below)'}.
                </ArofloChoice>
              )}
              {/* Call Back has no invoice/install fields of its own — the one
                  thing AroFlo's schedule can usefully suggest here is its
                  own Attending Technician, and only ever when exactly one
                  CRM technician's full name is found within AroFlo's
                  free-text resource name. No match/ambiguous: shown as plain
                  text only, nothing to click, left fully manual. */}
              {arofloView.callBackTechnician === 'choice' && (
                <ArofloChoice buttonLabel="Use as attending technician" onUse={applyArofloAttendingTechnician}>
                  AroFlo shows a scheduled visit: <strong>{arofloResult.scheduled.technicianName}</strong> on{' '}
                  <strong>{arofloResult.scheduled.date}</strong>.
                </ArofloChoice>
              )}
              {arofloView.callBackTechnician === 'unmatched' && (
                <div style={{ marginTop: 6 }}>
                  AroFlo shows a scheduled visit: <strong>{arofloResult.scheduled.technicianName}</strong> on{' '}
                  <strong>{arofloResult.scheduled.date}</strong> (no confident match to a technician on file — select one manually).
                </div>
              )}
              <ArofloActivity activity={arofloResult.activity} />
            </div>
          )}
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
          <div className="field">
            <SelectField
              label="Credited technician (original work) *"
              value={form.creditedTechnicianId}
              onChange={(v) => patch({ creditedTechnicianId: v })}
              options={withInactiveLabel(settings.technicians)}
              invalid={invalidFields.has('creditedTechnicianId')}
            />
            {callBackJobLookup?.found && (
              <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
                {callBackJobLookup.workCompletion === 'Install scheduled — different day'
                  ? 'Auto-filled with whoever completed the original work on a different day (not necessarily who made the sale) — still editable if it needs correcting.'
                  : "Auto-filled from the original job's own technician — still editable if it needs correcting."}
              </div>
            )}
          </div>
        </div>
      )}

      {(isExistingJob || isUpsell || isPendingCancellation) && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <DateField
            label={isUpsell ? 'Date upsell logged' : 'Date entered'}
            value={form.dateLogged}
            onChange={(v) => patch({ dateLogged: v })}
          />
          <SelectField
            label={isExistingJob || isUpsell ? 'Credited technician *' : 'Credited technician'}
            value={form.creditedTechnicianId}
            onChange={(v) => patch({ creditedTechnicianId: v })}
            options={withInactiveLabel(settings.technicians)}
            invalid={invalidFields.has('creditedTechnicianId')}
          />
          {isUpsell && (
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: -8 }}>
              The technician who actually made the upsell — so they receive the correct credit, even though a different technician
              may have originally attended this job.
            </div>
          )}
        </div>
      )}

      {(isNewJob || isExistingJob || isUpsell || isCallBack) && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <SelectField
            label={isNewJob || (isUpsell && form.predatesCrm) ? 'Trade *' : 'Trade'}
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
          {isNewJob && callLookup?.found && (callLookup.tradeId === form.tradeId || callLookup.jobTypeId === form.jobTypeId) && (
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: -8 }}>
              Trade/Job type auto-filled from the matching Calls &amp; Contacts record for this Job Number — still editable if it
              needs correcting.
            </div>
          )}
          {isNewJob && (
            <div className="field">
              <SelectField
                label="Lead *"
                value={form.lead}
                onChange={handleLeadChange}
                options={LEAD_OPTIONS}
                // A Sale Made job is always Qualified. The one exception is an
                // older Sale Made entry saved as Not Qualified, so staff can
                // correct it (it can't be saved until they do).
                disabled={(isSaleMade && !legacySaleMadeNotQualified) || leadBlockedBy.length > 0}
                invalid={invalidFields.has('lead')}
              />
              {leadBlockedBy.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
                  Lead can’t be changed on this job because it has {leadBlockedBy.join(' and ')}. That needs resolving separately first.
                </div>
              )}
              {isSaleMade && !legacySaleMadeNotQualified && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>A Sale Made job is always Qualified.</div>
              )}
              {legacySaleMadeNotQualified && (
                <div className="lookup-box lookup-missing">
                  Flagged for review: this Sale Made entry was saved as Not Qualified, but a Sale Made job is always Qualified. Change Lead
                  to Qualified to save any change to this entry.
                </div>
              )}
            </div>
          )}
          {(isExistingJob || isUpsell) && (
            <div className="field">
              <SuburbPicker value={form.suburb} onChange={(v) => patch({ suburb: v })} />
              {!arofloResult?.suburb && lookupResult?.found && lookupResult.suburb && form.suburb === lookupResult.suburb && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
                  Auto-filled from the original {isExistingJob ? 'Job Number' : "job's own suburb"} above — still editable if it needs
                  correcting.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isNewJob && (
        <div className="grid-form" style={{ marginTop: 14 }}>
          <YesNoField
            label="Inspection sheet"
            value={form.inspectionSheet}
            onChange={(v) => patch({ inspectionSheet: v })}
            disabled={isNotQualifiedNoSale && !isYesNo(form.inspectionSheet)}
          />
          <YesNoField
            label="Option sheet"
            value={form.optionSheet}
            onChange={(v) => patch({ optionSheet: v })}
            disabled={isNotQualifiedNoSale && !isYesNo(form.optionSheet)}
          />
          <div className="field">
            <label>Knock back</label>
            <select value={knockbackDisplay} disabled>
              <option>{knockbackDisplay}</option>
            </select>
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              {isNotQualifiedNoSale
                ? 'N/A — a Not Qualified job is never a knock-back, and its N/A sheets don’t count towards any percentage.'
                : 'Set automatically — only a No Sale entry with a Qualified lead counts as a knock-back.'}
            </div>
          </div>
          {isNotQualifiedNoSale && (isYesNo(form.inspectionSheet) || isYesNo(form.optionSheet)) && (
            <div className="lookup-box lookup-missing" style={{ gridColumn: '1 / -1' }}>
              This Not Qualified job was saved before sheets were set to N/A, so it still shows{' '}
              {[isYesNo(form.inspectionSheet) && `Inspection Sheet: ${form.inspectionSheet}`, isYesNo(form.optionSheet) && `Option Sheet: ${form.optionSheet}`]
                .filter(Boolean)
                .join(' and ')}
              . It's left as saved unless you change it.{' '}
              <button type="button" className="btn btn-sm" onClick={() => patch({ inspectionSheet: NA, optionSheet: NA })}>
                Set both to N/A
              </button>
            </div>
          )}
          {!isSaleMade && (!isNotQualifiedNoSale || form.knockbackReasonId) && (
            <SelectField
              label={isGenuineKnockback ? 'Reason for knock back *' : 'Reason for knock back'}
              value={form.knockbackReasonId}
              onChange={(v) => patch({ knockbackReasonId: v })}
              options={settings.lists.knockback_reason}
              invalid={invalidFields.has('knockbackReasonId')}
            />
          )}
          {isGenuineKnockback && !editing && (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <Checkbox
                label="Follow-up required"
                checked={form.followUpRequired}
                onChange={(v) => patch({ followUpRequired: v, followUpDueDate: v ? form.followUpDueDate : '' })}
              />
              {form.followUpRequired && (
                <div style={{ marginTop: 8, maxWidth: 220 }}>
                  <DateField
                    label="Follow-up due date *"
                    value={form.followUpDueDate}
                    onChange={(v) => patch({ followUpDueDate: v })}
                    invalid={invalidFields.has('followUpDueDate')}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 4 }}>
                    Defaults to the configured number of days after the visit date (Settings → Data) — always editable here.
                  </div>
                </div>
              )}
            </div>
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

      {isUpsell && (
        <div className="panel" style={{ padding: 16, marginTop: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Upsell — added to the existing invoice above</div>
          <div className="grid-form">
            <DateField
              label={form.predatesCrm ? 'Relevant invoice date *' : 'Relevant invoice date'}
              value={form.invoiceDate}
              onChange={(v) => patch({ invoiceDate: v })}
              invalid={invalidFields.has('invoiceDate')}
            />
            <NumberField
              label="Upsell value (ex GST) ($) *"
              value={form.saleValueExGst}
              onChange={(v) => patch({ saleValueExGst: v })}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 8 }}>
            Record only the ADDITIONAL upsell value ex GST — never the full invoice value again. This is included in the technician's
            overall credited Value (ex GST), but is never counted as a Sale (invoice) or in their Average Sale.
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
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Update entry' : 'Save entry'}
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
