import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { todayLocalDate } from '../../lib/dates.js';
import { TextField, TextAreaField, SelectField, DateField, StarRatingField, MultiSelectField } from '../../components/Fields.jsx';

function emptyForm() {
  return { reviewDate: todayLocalDate(), rating: 0, technicianIds: [], reviewLinkSent: '', jobNumber: '', notes: '' };
}

export default function LogReview({ editing, onSaved, onCancelEdit, setNotice }) {
  const settings = useSettings();
  const [form, setForm] = useState(emptyForm());

  useEffect(() => {
    if (editing) {
      setForm({
        reviewDate: editing.reviewDate,
        rating: editing.rating,
        technicianIds: editing.technicians.map((t) => t.id),
        reviewLinkSent: editing.reviewLinkSent || '',
        jobNumber: editing.jobNumber || '',
        notes: editing.notes || '',
      });
    } else {
      setForm(emptyForm());
    }
  }, [editing]);

  function patch(p) {
    setForm((f) => ({ ...f, ...p }));
  }

  // Every technician already active, plus any inactive one already credited
  // on the review being edited — so re-opening an older review never seems
  // to have silently lost one of its technicians just because they've since
  // been deactivated.
  const technicianOptions = settings.technicians.filter((t) => t.active || form.technicianIds.includes(t.id));

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.rating) {
      setNotice('Please select a Star Rating before saving.', true);
      return;
    }
    if (form.technicianIds.length === 0) {
      setNotice('Please select at least one Technician before saving.', true);
      return;
    }
    try {
      if (editing) {
        await api.reviews.update(editing.id, form);
        setNotice('Review updated.');
      } else {
        await api.reviews.create(form);
        setNotice('Review logged.');
      }
      onSaved();
      if (!editing) setForm(emptyForm());
    } catch (err) {
      setNotice(err.message, true);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel" style={{ padding: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{editing ? 'Update review' : 'New review'}</div>
      </div>

      <div className="grid-form">
        <DateField label="Review Date *" value={form.reviewDate} onChange={(v) => patch({ reviewDate: v })} />
        <StarRatingField label="Star Rating *" value={form.rating} onChange={(v) => patch({ rating: v })} />
        <SelectField
          label="Review Link Sent"
          value={form.reviewLinkSent}
          onChange={(v) => patch({ reviewLinkSent: v })}
          options={['Yes', 'No']}
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <MultiSelectField
          label="Technician(s) *"
          value={form.technicianIds}
          onChange={(v) => patch({ technicianIds: v })}
          options={technicianOptions}
        />
      </div>

      <div className="grid-form" style={{ marginTop: 14 }}>
        <TextField label="Job number (optional)" value={form.jobNumber} onChange={(v) => patch({ jobNumber: v })} mono maxWidth={200} />
      </div>

      <div style={{ marginTop: 14 }}>
        <TextAreaField
          label="Notes or Review Reference (optional)"
          value={form.notes}
          onChange={(v) => patch({ notes: v })}
          placeholder="Anything relevant — a quote/link, or what the review said"
        />
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button type="submit" className="btn btn-primary">
          {editing ? 'Update review' : 'Save review'}
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
