import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Fetch `path` on mount (and when it changes); optional polling interval in ms. */
export function useApi(path, { interval } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api(path));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    reload();
    if (!interval) return undefined;
    const t = setInterval(reload, interval);
    return () => clearInterval(t);
  }, [reload, interval]);

  return { data, error, loading, reload, setData };
}
