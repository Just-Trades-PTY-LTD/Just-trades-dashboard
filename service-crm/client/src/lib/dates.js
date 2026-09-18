function pad(n) {
  return String(n).padStart(2, '0');
}

export function nowLocalDateTime() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function money(v) {
  return `$${Math.round(v || 0).toLocaleString()}`;
}
