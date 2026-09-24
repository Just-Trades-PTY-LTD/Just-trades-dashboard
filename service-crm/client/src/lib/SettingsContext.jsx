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
    knockback_reason: [],
    callback_reason: [],
    pending_cancellation_reason: [],
  },
  suburbCount: 0,
};

export function SettingsProvider({ children }) {
  const [bundle, setBundle] = useState(EMPTY_BUNDLE);
  // `staff` is active-only — for dropdowns that assign new work (e.g.
  // "Handled by"). `staffAll` includes deactivated accounts — for a
  // historical filter (Call History, Reports, admin Activity), where a
  // deactivated account's past work still needs to be findable by name.
  const [staff, setStaff] = useState([]);
  const [staffAll, setStaffAll] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [b, s, sAll] = await Promise.all([api.settings.bundle(), api.users.directory(), api.users.directoryAll()]);
    setBundle(b);
    setStaff(s);
    setStaffAll(sAll);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  function jobTypesFor(tradeId) {
    const trade = bundle.trades.find((t) => t.id === Number(tradeId));
    return trade ? trade.jobTypes : [];
  }

  // Technicians available for assigning NEW work — active only, plus
  // whichever technician is already selected (so editing a record that
  // already names a since-deactivated technician still shows them, without
  // offering them for any other new assignment). Deactivating someone is
  // never undone just by their old record still pointing at them.
  function activeTechniciansFor(selectedId) {
    return bundle.technicians.filter((t) => t.active || String(t.id) === String(selectedId));
  }

  return (
    <SettingsContext.Provider value={{ ...bundle, staff, staffAll, loading, refresh, jobTypesFor, activeTechniciansFor }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
