import { useEffect, useMemo, useState } from 'react';

// ── Author avatar (T-038) ────────────────────────────────────────
//
// Resolves a Gravatar image for the given email; falls back to a
// deterministic coloured circle with the author's initials when the
// network call fails or the user has disabled avatars via settings.
//
// Hashes are cached in a module-level Map so a long commit list (one
// avatar per row) doesn't re-hash the same email for every render.
// The browser's HTTP cache handles the actual image fetch caching.

const hashCache = new Map<string, string>();
const failedHashes = new Set<string>();

function hashFor(email: string): string {
  const key = email.trim().toLowerCase();
  let h = hashCache.get(key);
  if (h !== undefined) return h;
  // Defensive: if the preload bridge is missing the function (older
  // build, packaging hiccup, etc.) or md5 throws for any reason, fall
  // back to an empty hash so the avatar skips straight to the
  // initials circle instead of crashing the renderer.
  try {
    h = (typeof window.api?.md5 === 'function') ? window.api.md5(key) : '';
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

// Simple deterministic colour from a string. Used for the fallback
// avatar so each author gets a visually distinct circle even offline.
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
  /** When false, skip the gravatar fetch entirely — used when the
   * user has turned off network avatars in settings. We still render
   * the deterministic initials circle. */
  enableNetwork?: boolean;
}

export function AuthorAvatar({ email, name, size = 18, enableNetwork = true }: AuthorAvatarProps) {
  const hash = useMemo(() => hashFor(email), [email]);
  const [failed, setFailed] = useState(() => failedHashes.has(hash));

  useEffect(() => {
    if (failedHashes.has(hash)) setFailed(true);
  }, [hash]);

  // Empty hash means the preload bridge wasn't available or md5
  // failed; skip the gravatar fetch entirely and render the initials
  // circle. Same fallback path as a 404 or onError.
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
      onError={() => {
        failedHashes.add(hash);
        setFailed(true);
      }}
    />
  );
}
