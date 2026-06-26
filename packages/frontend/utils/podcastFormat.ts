/**
 * Formatting helpers for podcast episode metadata (duration + publish date).
 */

/**
 * Format an episode duration (seconds) as a human label.
 * Long-form: `1 hr 23 min`; short-form: `42 min`; sub-minute: `45 sec`.
 */
export function formatEpisodeDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) {
    return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  }
  if (minutes > 0) {
    return `${minutes} min`;
  }
  return `${total} sec`;
}

/**
 * Format an episode `pubDate` ISO string as a relative label for recent dates
 * (`Today`, `Yesterday`, `3 days ago`) and an absolute date beyond a week.
 */
export function formatPubDate(pubDate: string | undefined): string {
  if (!pubDate) {
    return '';
  }
  const parsed = Date.parse(pubDate);
  if (!Number.isFinite(parsed)) {
    return '';
  }

  const diffMs = Date.now() - parsed;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return 'Today';
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  return new Date(parsed).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Strip HTML tags + decode the most common entities from an episode/show
 * description so it can be rendered as plain `Text` (feeds ship HTML bodies).
 */
export function stripHtml(html: string | undefined): string {
  if (!html) {
    return '';
  }
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remaining-time label for an in-progress episode (`12 min left`).
 */
export function formatRemaining(positionSec: number, durationSec: number): string {
  const remaining = Math.max(0, durationSec - positionSec);
  if (remaining <= 0) {
    return 'Played';
  }
  return `${formatEpisodeDuration(remaining)} left`;
}
