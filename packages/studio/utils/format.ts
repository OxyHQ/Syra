/** Format a duration in seconds as `H:MM:SS` or `M:SS`. */
export function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * A show's episode count with its noun agreed (`1 episode`, `7 episodes`).
 *
 * One spelling because a delete confirmation and the show header must not be
 * able to disagree about how much a show holds — the confirmation is telling a
 * creator what they are about to destroy, so the number has to be the same one
 * they were just looking at.
 */
export function pluralEpisodes(count: number): string {
  return `${count} ${count === 1 ? 'episode' : 'episodes'}`;
}

/** Format an ISO date string as a short, locale-aware date (e.g. `Jun 26, 2026`). */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
