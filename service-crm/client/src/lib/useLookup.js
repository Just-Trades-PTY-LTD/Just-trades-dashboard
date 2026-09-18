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
