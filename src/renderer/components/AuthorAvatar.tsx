import { useMemo, useState } from 'react';
import { md5 } from '../lib/md5';

// ── Author avatar (T-038) ────────────────────────────────────────
//
// Resolves a Gravatar image for the given email; falls back to a
// deterministic coloured circle with the author's initials when the
// network call fails or the URL doesn't have a matching avatar.
//
// MD5 is computed in the renderer via a tiny pure-JS implementation
// (`lib/md5.ts`) — earlier attempts to route it through the preload
// crashed vite's bundling, so we keep the algorithm in-renderer.
// We cache the hash itself (deterministic, cheap), but deliberately
// do NOT persist a "this URL 404'd" cache across remounts — that
// previously stuck on the fallback path forever after the first
// load, so registering a new gravatar wouldn't surface without a
// full app restart. The browser's HTTP cache (gravatar 404s carry
// Cache-Control headers) handles re-attempt cost.

const hashCache = new Map<string, string>();

function hashFor(email: string): string {
  const key = email.trim().toLowerCase();
  let h = hashCache.get(key);
  if (h !== undefined) return h;
  // Defensive: an empty email is harmless to hash, but we treat it
  // the same as "no avatar" so the fallback renders without firing
  // a useless gravatar request.
  if (!key) {
    hashCache.set(key, '');
    return '';
  }
  try {
    h = md5(key);
  } catch {
    h = '';
  }
  hashCache.set(key, h);
  return h;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Simple deterministic colour from a string. Each author gets a
// visually distinct circle without any network round-trip.
function colourFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

export interface AuthorAvatarProps {
  email: string;
  name: string;
  size?: number;
  /** When false, skip gravatar and render the initials circle. The
   * setting is plumbed in from App → GitChangesPanel → GitTree so
   * users on restricted networks can stay text-only. */
  enableNetwork?: boolean;
}

export function AuthorAvatar({ email, name, size = 18, enableNetwork = true }: AuthorAvatarProps) {
  const hash = useMemo(() => hashFor(email), [email]);
  // `failed` flips when the gravatar fetch 404s for this hash. Kept
  // local to this mount so a permanent across-the-app cache doesn't
  // strand the user on the fallback after they register a real
  // gravatar — the next remount (scroll, panel toggle) retries.
  const [failed, setFailed] = useState(false);

  if (!enableNetwork || failed || !hash) {
    return (
      <span
        className="author-avatar author-avatar-fallback"
        style={{
          width: size,
          height: size,
          background: colourFor(email || name),
          fontSize: Math.max(8, Math.floor(size * 0.5)),
        }}
        title={name}
      >
        {initialsFor(name)}
      </span>
    );
  }

  // `d=404` tells gravatar to return HTTP 404 when there's no
  // matching avatar — we use that to drive the fallback. `s` is the
  // size in pixels; double it for hi-DPI screens.
  const url = `https://www.gravatar.com/avatar/${hash}?d=404&s=${size * 2}`;
  return (
    <img
      className="author-avatar"
      src={url}
      width={size}
      height={size}
      alt=""
      title={name}
      // `loading="lazy"` keeps the browser from firing 1000+ HTTPS
      // requests when a long commit graph mounts — only the visible
      // rows hit gravatar; the rest load as the user scrolls.
      loading="lazy"
      decoding="async"
      style={{ width: size, height: size, borderRadius: size / 2 }}
      onError={() => setFailed(true)}
    />
  );
}
