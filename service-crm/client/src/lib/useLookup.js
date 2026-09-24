import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function useJobLookup(jobNumber, mode) {
  const [result, setResult] = useState(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!jobNumber || !jobNumber.trim()) {
      setResult(null);
      return;
    }
    // Clear immediately rather than leaving the previous Job Number's result
    // in place while the debounce/fetch for the new value is in flight —
    // otherwise a stale "found" from the last value could be misread as
    // applying to the new one (e.g. a duplicate-Job-Number check briefly
    // flagging a genuinely different JN right after it's typed).
    setResult(null);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const fn = mode === 'sale' ? api.lookup.sale : api.lookup.job;
      fn(jobNumber)
        .then(setResult)
        .catch(() => setResult(null));
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [jobNumber, mode]);

  return result;
}
