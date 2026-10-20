/** `D Mon` for a civil `YYYY-MM-DD`. Adds the year only when it is not `today`'s year. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatCivilDate(day: string, today?: string): string {
  const iso = day.slice(0, 10);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const date = Number(iso.slice(8, 10));
  const label = `${date} ${MONTHS[month - 1] ?? ''}`;
  if (today && Number(today.slice(0, 4)) !== year) return `${label} ${year}`;
  return label;
}
