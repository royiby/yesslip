const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * Day-of-week for an ISO "YYYY-MM-DD" date, computed from the civil date itself
 * rather than from a parsed Date in the host timezone, so the label never
 * shifts when the server runs in UTC. Every tenant's dates arrive as civil
 * dates and must stay civil dates.
 */
export function dayOfWeek(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "2026-12-06" to "יום ראשון 6.12" */
export function dayLabel(isoDate) {
  const [, m, d] = String(isoDate).split('-').map(Number);
  return `יום ${DAY_NAMES[dayOfWeek(isoDate)]} ${d}.${m}`;
}

/** "2026-12-06" to "ראשון 6.12" */
export function dayLabelShort(isoDate) {
  const [, m, d] = String(isoDate).split('-').map(Number);
  return `${DAY_NAMES[dayOfWeek(isoDate)]} ${d}.${m}`;
}

/** "2026-12-06" to "6.12" */
export function dateShort(isoDate) {
  const [, m, d] = String(isoDate).split('-').map(Number);
  return `${d}.${m}`;
}

/** 750 to "750 ₪"; 749.5 to "749.50 ₪" */
export function money(amount) {
  const n = Number(amount);
  const str = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${str} ₪`;
}

/** 1 to "יום אחד", 2 to "2 ימים" */
export function daysWord(count) {
  return count === 1 ? 'יום אחד' : `${count} ימים`;
}
