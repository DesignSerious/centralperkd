import { useEffect, useState } from 'react';

// Seconds remaining until `deadline` (an absolute timestamp from the server),
// re-rendered once per second. Returns null when deadline is null.
export function useCountdown(deadline) {
  const calc = () => (deadline ? Math.max(0, Math.round((deadline - Date.now()) / 1000)) : null);
  const [s, setS] = useState(calc);
  useEffect(() => {
    if (!deadline) { setS(null); return; }
    setS(calc());
    const id = setInterval(() => setS(calc()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return s;
}
