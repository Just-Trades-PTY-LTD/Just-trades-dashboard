import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function Home({ setModule, isAdmin }) {
  const [counts, setCounts] = useState({ calls: null, jobs: null, activeFollowUps: null, reviews: null });

  useEffect(() => {
    let alive = true;
    Promise.all([api.calls.list({}), api.tech.entries({}), api.followUps.list({ status: 'active' }), api.reviews.list()]).then(
      ([calls, entries, followUps, reviews]) => {
        if (alive) setCounts({ calls: calls.length, jobs: entries.length, activeFollowUps: followUps.entries.length, reviews: reviews.length });
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  const cards = [
    {
      id: 'calls',
      title: 'Calls & Contacts',
      desc: 'Log calls, texts, emails and other contacts — leads, quote approvals, call backs and cancellations.',
      stat: counts.calls === null ? 'Loading…' : `${counts.calls} active contacts logged`,
    },
    {
      id: 'tech',
      title: 'Technician & sales',
      desc: 'Log technician job visits, sales, call backs and pending cancellations.',
      stat: counts.jobs === null ? 'Loading…' : `${counts.jobs} active job entries`,
    },
    {
      id: 'followups',
      title: 'Follow-ups',
      desc: 'View upcoming, due, overdue and completed follow-up tasks.',
      stat:
        counts.activeFollowUps === null
          ? 'View active follow-ups'
          : `${counts.activeFollowUps} active follow-up${counts.activeFollowUps === 1 ? '' : 's'}`,
    },
    {
      id: 'reviews',
      title: 'Reviews',
      desc: 'Log new Google reviews, browse Review History, and see review performance in Reports.',
      stat: counts.reviews === null ? 'Loading…' : `${counts.reviews} review${counts.reviews === 1 ? '' : 's'} logged`,
    },
    {
      id: 'reports',
      title: 'Reports',
      desc: 'Company, trade and technician performance — leads, sales, conversion and knock-backs.',
      stat: 'Calls and technician reports in one place',
    },
    ...(isAdmin
      ? [
          {
            id: 'settings',
            title: 'Settings',
            desc: 'Categories, staff, trades, suburbs, and data export / backup.',
            stat: 'Everything here is editable',
          },
        ]
      : []),
  ];

  return (
    <div className="grid-cards">
      {cards.map((c) => (
        <div key={c.id} className="home-card" onClick={() => setModule(c.id)}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent-dark)', marginBottom: 6 }}>{c.title}</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 10 }}>{c.desc}</div>
          <div style={{ fontSize: 12, color: 'var(--accent)' }}>{c.stat}</div>
        </div>
      ))}
    </div>
  );
}
