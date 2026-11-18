import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth/AuthContext.jsx';
import { api } from './lib/api.js';
import { useCrmNav, makeSliceSetter } from './lib/crmNav.js';
import { SettingsProvider } from './lib/SettingsContext.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import CallsPage from './pages/Calls/index.jsx';
import TechSalesPage from './pages/TechSales/index.jsx';
import ReportsPage from './pages/Reports/index.jsx';
import SettingsPage from './pages/Settings/index.jsx';
import FollowUpsPage from './pages/FollowUps/index.jsx';
import ReviewsPage from './pages/Reviews/index.jsx';
import NeedsAttentionPage from './pages/NeedsAttention/index.jsx';
import TechnicianApp from './pages/Me/TechnicianApp.jsx';
import logo from './assets/logo.png';
import NewVersionNotice from './components/NewVersionNotice.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

const BASE_TABS = [
  ['home', 'Home'],
  ['needs', 'Needs Attention'],
  ['calls', 'Calls & Contacts'],
  ['tech', 'Technician & sales'],
  ['followups', 'Follow-ups'],
  ['reviews', 'Reviews'],
  ['reports', 'Reports'],
];

export default function App() {
  const { user, loading, logout } = useAuth();
  const [nav, updateNav] = useCrmNav();
  // Needs Attention count for the tab (office accounts only), refreshed when
  // the page changes and every 5 minutes.
  const isOffice = user && (user.role === 'admin' || user.role === 'staff');
  const [needsCount, setNeedsCount] = useState(null);
  const refreshNeedsCount = useCallback(() => {
    if (!isOffice) return;
    api.needsAttention.count().then((d) => setNeedsCount(d.count)).catch(() => {});
  }, [isOffice]);
  useEffect(() => {
    refreshNeedsCount();
    const t = setInterval(refreshNeedsCount, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [refreshNeedsCount, nav.module]);

  if (loading) return null;
  if (!user) return <Login />;
  // A Technician account gets only My Performance, My Reviews and My account
  // (pages/Me/TechnicianApp.jsx) — none of the Staff modules below, and the
  // server refuses every other route for it regardless of this screen.
  if (user.role === 'technician') return <TechnicianApp user={user} logout={logout} />;

  const isAdmin = user.role === 'admin';
  // Settings holds only admin-only tools (staff accounts, lists/config,
  // backup/restore, activity history) — never shown to a staff user, and the
  // backend enforces the same boundary independently of this tab existing.
  const tabs = isAdmin ? [...BASE_TABS, ['settings', 'Settings']] : BASE_TABS;
  // A staff session that still has 'settings' recorded from an earlier admin
  // session on this browser (or a role downgrade) should land somewhere real.
  const activeModule = tabs.some(([id]) => id === nav.module) ? nav.module : 'home';

  function setModule(id) {
    updateNav((prev) => ({ ...prev, module: id }));
  }

  // A single logical action (clicking "View job →") — one Back-stop, not
  // two: the module switch pushes the new history entry, and the target
  // page's own effect (consuming pendingJump) amends that same entry rather
  // than pushing a second one — see Calls/TechSales index.jsx.
  function jumpToJN(target, jn) {
    updateNav((prev) => ({ ...prev, module: target, pendingJump: { target, jn } }));
  }
  // "View original knockback job" from a report drill-down's fixed row set
  // (see JobHistory.jsx) — an exact-id jump, never a job_number text match,
  // so it can only ever open the one specific job it's linked to.
  function jumpToJobId(target, jobId) {
    updateNav((prev) => ({ ...prev, module: target, pendingJump: { target, jobId } }));
  }
  // Needs Attention "Open": the record's own normal screen. A call opens in
  // Calls & Contacts and a Technician & Sales entry opens for editing, both
  // from the same lists those screens use; a Job Number opens the matching
  // history list. Nothing is changed by opening.
  async function openRecord(open) {
    if (!open) return;
    if (open.module === 'followups') return setModule('followups');
    if (open.jn !== undefined) return jumpToJN(open.module, open.jn);
    try {
      if (open.module === 'calls') {
        const rows = await api.calls.list({ includeArchived: true });
        const call = rows.find((c) => c.id === open.id);
        if (call) return updateNav((prev) => ({ ...prev, module: 'calls', calls: { ...prev.calls, sub: 'log', editing: call } }));
      } else {
        const rows = await api.tech.entries({ includeArchived: 'true' });
        const entry = rows.find((e) => e.kind === open.kind && e.id === open.id);
        if (entry) return updateNav((prev) => ({ ...prev, module: 'tech', tech: { ...prev.tech, sub: 'log', editing: entry } }));
      }
    } catch {
      // Fall through to the module itself.
    }
    setModule(open.module);
  }

  function clearJump() {
    updateNav((prev) => ({ ...prev, pendingJump: null }), { push: false });
  }

  // "View follow-up" from Job History — same one-Back-stop pattern as
  // jumpToJN: switch tabs and open the task's detail view as a single
  // logical action.
  function openFollowUp(id) {
    updateNav((prev) => ({ ...prev, module: 'followups', followups: { ...prev.followups, editing: id } }));
  }

  const setCallsSub = makeSliceSetter(updateNav, 'calls', 'sub');
  const setCallsEditing = makeSliceSetter(updateNav, 'calls', 'editing');
  const setTechSub = makeSliceSetter(updateNav, 'tech', 'sub');
  const setTechEditing = makeSliceSetter(updateNav, 'tech', 'editing');
  const setReportsSub = makeSliceSetter(updateNav, 'reports', 'sub');
  const setReportsCallsDrilldown = makeSliceSetter(updateNav, 'reports', 'callsDrilldown');
  const setReportsTechDrilldown = makeSliceSetter(updateNav, 'reports', 'techDrilldown');
  const setReportsReviewsDrilldown = makeSliceSetter(updateNav, 'reports', 'reviewsDrilldown');
  const setSettingsSub = makeSliceSetter(updateNav, 'settings', 'sub');
  const setFollowUpsSub = makeSliceSetter(updateNav, 'followups', 'sub');
  const setFollowUpsEditing = makeSliceSetter(updateNav, 'followups', 'editing');
  const setReviewsSub = makeSliceSetter(updateNav, 'reviews', 'sub');
  const setReviewsEditing = makeSliceSetter(updateNav, 'reviews', 'editing');
  const pendingJump = nav.pendingJump;

  // Contact History, Job History and Review History show dense, many-column
  // tables — widen the page just for those views so they can use more of a
  // large screen, without changing the comfortable width of every other page.
  const isWideHistoryView =
    (activeModule === 'calls' && nav.calls.sub === 'history') ||
    (activeModule === 'tech' && nav.tech.sub === 'history') ||
    (activeModule === 'reviews' && nav.reviews.sub === 'history');

  return (
    <SettingsProvider>
      <NewVersionNotice />
      <div className={`app-shell${isWideHistoryView ? ' app-shell--wide' : ''}`}>
        <div className="app-header">
          <img src={logo} alt="Just Trades" className="app-logo" />
          <div className="app-header-right">
            <span>
              {user.name} · {user.role === 'admin' ? 'Admin' : 'Staff'}
            </span>
            <button className="btn btn-sm" onClick={logout} type="button">
              Sign out
            </button>
          </div>
        </div>

        <div className="app-tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className={`tab ${activeModule === id ? 'active' : ''}`} onClick={() => setModule(id)} type="button">
              {label}
              {id === 'needs' && needsCount > 0 && (
                <span className="badge badge-warn" style={{ marginLeft: 6 }} data-testid="needs-count">
                  {needsCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <ErrorBoundary key={activeModule} screen={activeModule}>
        {activeModule === 'home' && <Home setModule={setModule} isAdmin={isAdmin} needsCount={needsCount} />}
        {activeModule === 'needs' && <NeedsAttentionPage openRecord={openRecord} onCountChange={setNeedsCount} />}
        {activeModule === 'calls' && (
          <CallsPage
            sub={nav.calls.sub}
            setSub={setCallsSub}
            editing={nav.calls.editing}
            setEditing={setCallsEditing}
            pendingJump={pendingJump && pendingJump.target === 'calls' ? pendingJump : null}
            clearJump={clearJump}
            jumpToJN={jumpToJN}
          />
        )}
        {activeModule === 'tech' && (
          <TechSalesPage
            sub={nav.tech.sub}
            setSub={setTechSub}
            editing={nav.tech.editing}
            setEditing={setTechEditing}
            pendingJump={pendingJump && pendingJump.target === 'tech' ? pendingJump : null}
            clearJump={clearJump}
            jumpToJN={jumpToJN}
            openFollowUp={openFollowUp}
          />
        )}
        {activeModule === 'followups' && (
          <FollowUpsPage sub={nav.followups.sub} setSub={setFollowUpsSub} editing={nav.followups.editing} setEditing={setFollowUpsEditing} />
        )}
        {activeModule === 'reviews' && (
          <ReviewsPage sub={nav.reviews.sub} setSub={setReviewsSub} editing={nav.reviews.editing} setEditing={setReviewsEditing} />
        )}
        {activeModule === 'reports' && (
          <ReportsPage
            sub={nav.reports.sub}
            setSub={setReportsSub}
            callsDrilldown={nav.reports.callsDrilldown}
            setCallsDrilldown={setReportsCallsDrilldown}
            techDrilldown={nav.reports.techDrilldown}
            setTechDrilldown={setReportsTechDrilldown}
            reviewsDrilldown={nav.reports.reviewsDrilldown}
            setReviewsDrilldown={setReportsReviewsDrilldown}
            jumpToJN={jumpToJN}
            jumpToJobId={jumpToJobId}
          />
        )}
        {activeModule === 'settings' && isAdmin && <SettingsPage sub={nav.settings.sub} setSub={setSettingsSub} isAdmin={isAdmin} />}
        </ErrorBoundary>
      </div>
    </SettingsProvider>
  );
}
