import { Component } from 'react';

// If a screen hits an unexpected error while drawing, show a clear message
// instead of a blank page, and send the error text (no form contents) to the
// server log so the cause can be found. Nothing is saved or changed.
function reportError(error, info, screen) {
  try {
    fetch('/api/client-error', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screen: String(screen || ''),
        message: String(error?.message || error || '').slice(0, 500),
        stack: String(error?.stack || '').slice(0, 1500),
        componentStack: String(info?.componentStack || '').slice(0, 1500),
      }),
    }).catch(() => {});
  } catch {
    // Reporting is best-effort only.
  }
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportError(error, info, this.props.screen);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel" role="alert" data-testid="screen-error" style={{ padding: 20, marginTop: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Something went wrong on this screen.</div>
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          Anything not yet saved on this screen was not saved. Reload the page and check before entering it again. The error has been
          recorded so it can be fixed.
        </div>
        <div className="mono" style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 12, wordBreak: 'break-word' }}>
          {String(this.state.error?.message || this.state.error)}
        </div>
        <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    );
  }
}
