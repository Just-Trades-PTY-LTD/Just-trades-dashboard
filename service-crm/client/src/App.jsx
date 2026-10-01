import { useAuth } from './auth/AuthContext.jsx';
import { useCrmNav, makeSliceSetter } from './lib/crmNav.js';
import { SettingsProvider } from './lib/SettingsContext.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import CallsPage from './pages/Calls/index.jsx';
import TechSalesPage from './pages/TechSales/index.jsx';
import ReportsPage from './pages/Reports/index.jsx';
import SettingsPage from './pages/Settings/index.jsx';
import logo from './assets/logo.png';

const BASE_TABS = [
  ['home', 'Home'],
  ['calls', 'Calls & Contacts'],
  ['tech', 'Technician & sales'],
  ['reports', 'Reports'],
];

export default function App() {
  const { user, loading, logout } = useAuth();
  const [nav, updateNav] = useCrmNav();

  if (loading) return null;
  if (!user) return <Login />;

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
  function clearJump() {
    updateNav((prev) => ({ ...prev, pendingJump: null }), { push: false });
  }

  const setCallsSub = makeSliceSetter(updateNav, 'calls', 'sub');
  const setCallsEditing = makeSliceSetter(updateNav, 'calls', 'editing');
  const setTechSub = makeSliceSetter(updateNav, 'tech', 'sub');
  const setTechEditing = makeSliceSetter(updateNav, 'tech', 'editing');
  const setReportsSub = makeSliceSetter(updateNav, 'reports', 'sub');
  const setReportsCallsDrilldown = makeSliceSetter(updateNav, 'reports', 'callsDrilldown');
  const setReportsTechDrilldown = makeSliceSetter(updateNav, 'reports', 'techDrilldown');
  const setSettingsSub = makeSliceSetter(updateNav, 'settings', 'sub');
  const pendingJump = nav.pendingJump;

  return (
    <SettingsProvider>
      <div className="app-shell">
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
            </button>
          ))}
        </div>

        {activeModule === 'home' && <Home setModule={setModule} isAdmin={isAdmin} />}
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
          />
        )}
        {activeModule === 'reports' && (
          <ReportsPage
            sub={nav.reports.sub}
            setSub={setReportsSub}
            callsDrilldown={nav.reports.callsDrilldown}
            setCallsDrilldown={setReportsCallsDrilldown}
            techDrilldown={nav.reports.techDrilldown}
            setTechDrilldown={setReportsTechDrilldown}
            jumpToJN={jumpToJN}
          />
        )}
        {activeModule === 'settings' && isAdmin && <SettingsPage sub={nav.settings.sub} setSub={setSettingsSub} isAdmin={isAdmin} />}
      </div>
    </SettingsProvider>
  );
}
