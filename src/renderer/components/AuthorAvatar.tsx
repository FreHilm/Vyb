// ── Author avatar (T-038) ────────────────────────────────────────
//
// V1 ships the deterministic coloured-initials variant — no network
// fetch. Gravatar support is parked: it needs an MD5 of the email
// and the only practical place to compute one is the preload (Node
// crypto), but routing it through there blew up vite's preload
// bundling. Initials-only is still useful (per-author colour helps
// scan a long commit list at a glance) and ships with zero runtime
// risk. Gravatar can come back as a follow-up once we have a clean
// preload story for the hash.

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
  /** Reserved for the future gravatar opt-in. Currently ignored —
   * the avatar always renders the initials circle. */
  enableNetwork?: boolean;
}

export function AuthorAvatar({ email, name, size = 18 }: AuthorAvatarProps) {
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
