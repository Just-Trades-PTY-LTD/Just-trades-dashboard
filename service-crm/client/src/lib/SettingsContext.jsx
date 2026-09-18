import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const SettingsContext = createContext(null);

const EMPTY_BUNDLE = {
  trades: [],
  technicians: [],
  lists: {
    lead_source: [],
    not_booked_reason: [],
    new_job_cancellation_reason: [],
    pending_job_cancellation_reason: [],
    knockback_reason: [],
    callback_reason: [],
    pending_cancellation_reason: [],
  },
  suburbCount: 0,
};

export function SettingsProvider({ children }) {
  const [bundle, setBundle] = useState(EMPTY_BUNDLE);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [b, s] = await Promise.all([api.settings.bundle(), api.users.directory()]);
    setBundle(b);
    setStaff(s);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  function jobTypesFor(tradeId) {
    const trade = bundle.trades.find((t) => t.id === Number(tradeId));
    return trade ? trade.jobTypes : [];
  }

  return (
    <SettingsContext.Provider value={{ ...bundle, staff, loading, refresh, jobTypesFor }}>{children}</SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
