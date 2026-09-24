import { useState } from 'react';
import { useAuth } from './auth/AuthContext.jsx';
import { useSessionState } from './lib/useSessionState.js';
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
  const [module, setModule] = useSessionState('crm.module', 'home');
  const [pendingJump, setPendingJump] = useState(null);

  if (loading) return null;
  if (!user) return <Login />;

  const isAdmin = user.role === 'admin';
  // Settings holds only admin-only tools (staff accounts, lists/config,
  // backup/restore, activity history) — never shown to a staff user, and the
  // backend enforces the same boundary independently of this tab existing.
  const tabs = isAdmin ? [...BASE_TABS, ['settings', 'Settings']] : BASE_TABS;
  // A staff session that still has 'settings' recorded from an earlier admin
  // session on this browser (or a role downgrade) should land somewhere real.
  const activeModule = tabs.some(([id]) => id === module) ? module : 'home';

  function jumpToJN(target, jn) {
    setModule(target);
    setPendingJump({ target, jn });
  }
  function clearJump() {
    setPendingJump(null);
  }

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
        {activeModule === 'calls' && <CallsPage pendingJump={pendingJump} clearJump={clearJump} jumpToJN={jumpToJN} />}
        {activeModule === 'tech' && <TechSalesPage pendingJump={pendingJump} clearJump={clearJump} jumpToJN={jumpToJN} />}
        {activeModule === 'reports' && <ReportsPage />}
        {activeModule === 'settings' && isAdmin && <SettingsPage isAdmin={isAdmin} />}
      </div>
    </SettingsProvider>
  );
}
