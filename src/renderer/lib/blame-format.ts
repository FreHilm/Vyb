// Tiny formatting helpers shared by the blame gutters (CodeMirror's
// `blame-gutter.ts` and the Monaco glyph-margin variant). Kept engine-
// agnostic — no editor imports — so either editor can pull them in
// without dragging the other's runtime along.

/** Compact relative-age stamp: now / 5m / 3h / 2d / 4mo / 1y. */
export function relativeDate(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/** 1–2 letter author initials: "Fredrik Hilmersson" → "FH". */
export function authorInitials(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
