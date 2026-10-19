import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { SubTabs } from '../../components/Fields.jsx';
import LogReview from './LogReview.jsx';
import ReviewHistory from './ReviewHistory.jsx';

export default function ReviewsPage({ sub, setSub, editing, setEditing }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNoticeState] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.reviews.list();
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setNotice(message, isError) {
    setNoticeState({ message, isError });
    setTimeout(() => setNoticeState(null), 5000);
  }

  // Opening a record is a Back-stop: pressing Back should return to Review
  // History. setEditing pushes that entry; setSub folds the tab switch into
  // the same entry rather than creating a second one — same pattern as
  // Calls/TechSales.
  function startEdit(review) {
    setEditing(review);
    setSub('log', { push: false });
  }

  function closeEdit() {
    if (editing) {
      setEditing(null, { push: false });
      setSub('history', { push: false });
    }
  }

  return (
    <div>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['log', 'Log a review'],
          ['history', 'Review history'],
        ]}
      />
      {notice && <div className={`notice panel ${notice.isError ? 'error' : ''}`}>{notice.message}</div>}
      {sub === 'log' && (
        <LogReview
          editing={editing}
          onSaved={() => {
            load();
            closeEdit();
          }}
          onCancelEdit={closeEdit}
          setNotice={setNotice}
        />
      )}
      {sub === 'history' && <ReviewHistory rows={rows} loading={loading} onEdit={startEdit} />}
    </div>
  );
}
