import { useState } from 'react';
import { useAuth } from './auth/AuthContext.jsx';
import { SettingsProvider } from './lib/SettingsContext.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import CallsPage from './pages/Calls/index.jsx';
import TechSalesPage from './pages/TechSales/index.jsx';
import ReportsPage from './pages/Reports/index.jsx';
import SettingsPage from './pages/Settings/index.jsx';
import logo from './assets/logo.png';

const TABS = [
  ['home', 'Home'],
  ['calls', 'Calls'],
  ['tech', 'Technician & sales'],
  ['reports', 'Reports'],
  ['settings', 'Settings'],
];

export default function App() {
  const { user, loading, logout } = useAuth();
  const [module, setModule] = useState('home');
  const [pendingJump, setPendingJump] = useState(null);

  if (loading) return null;
  if (!user) return <Login />;

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
          {TABS.map(([id, label]) => (
            <button key={id} className={`tab ${module === id ? 'active' : ''}`} onClick={() => setModule(id)} type="button">
              {label}
            </button>
          ))}
        </div>

        {module === 'home' && <Home setModule={setModule} />}
        {module === 'calls' && <CallsPage pendingJump={pendingJump} clearJump={clearJump} jumpToJN={jumpToJN} />}
        {module === 'tech' && <TechSalesPage pendingJump={pendingJump} clearJump={clearJump} jumpToJN={jumpToJN} />}
        {module === 'reports' && <ReportsPage />}
        {module === 'settings' && <SettingsPage isAdmin={user.role === 'admin'} />}
      </div>
    </SettingsProvider>
  );
}
