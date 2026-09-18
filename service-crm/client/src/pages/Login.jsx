import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import logo from '../assets/logo.png';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="panel login-card" onSubmit={handleSubmit}>
        <img src={logo} alt="Just Trades" style={{ height: 44, marginBottom: 20 }} />
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Service CRM</div>
        <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 20 }}>Sign in with your Just Trades account.</div>
        {error && <div className="notice error" style={{ marginBottom: 14 }}>{error}</div>}
        <div className="field" style={{ marginBottom: 14 }}>
          <label>Email</label>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field" style={{ marginBottom: 20 }}>
          <label>Password</label>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
