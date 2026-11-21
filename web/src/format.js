const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(iso) {
  if (!iso) return 'Never';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const date = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

/** Badge variant + label for a certificate expiry in `days`. */
export function expiryBadge(days) {
  if (days === null || days === undefined) return { variant: 'neutral', label: 'No certificate' };
  if (days < 0) return { variant: 'error', label: `Expired ${-days}d ago` };
  if (days <= 30) return { variant: 'warning', label: `Expires in ${days}d` };
  return { variant: 'success', label: `Valid ${days}d` };
}

export const hex32 = (n) => (n === null || n === undefined ? '—' : `0x${Number(n).toString(16).toUpperCase().padStart(8, '0')}`);
