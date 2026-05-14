import { gutter, GutterMarker, type EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { GitBlameLine } from '../../shared/types';

// ── Per-line blame gutter (T-027) ─────────────────────────────────
//
// Builds a CodeMirror gutter extension that renders one DOM element
// per line showing short-SHA, author initials, and a relative-date
// stamp. Clicking the marker calls `onSelect(sha)` so the host can
// jump to the commit in the Tree tab.
//
// The blame array is captured by closure, so callers must produce a
// fresh extension whenever the data changes (typically by holding the
// gutter inside a Compartment and reconfiguring on toggle). That keeps
// the per-line marker rendering pure — no StateField gymnastics for
// what is fundamentally a static snapshot of `git blame`.

function relativeDate(iso: string): string {
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

function authorInitials(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

class BlameMarker extends GutterMarker {
  constructor(
    private readonly entry: GitBlameLine,
    private readonly showSha: boolean,
    private readonly onSelect: (sha: string) => void,
  ) {
    super();
  }

  eq(other: BlameMarker): boolean {
    return other.entry.sha === this.entry.sha
      && other.entry.lineNumber === this.entry.lineNumber
      && other.showSha === this.showSha;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('button');
    wrap.className = 'cm-blame-marker';
    wrap.type = 'button';
    const uncommitted = /^0+$/.test(this.entry.sha);
    if (uncommitted) wrap.classList.add('cm-blame-marker-uncommitted');
    wrap.title = uncommitted
      ? 'Uncommitted change'
      : `${this.entry.shortSha} · ${this.entry.author} · ${relativeDate(this.entry.authorTime)}\n${this.entry.summary}`;
    wrap.onclick = (e) => {
      e.stopPropagation();
      if (!uncommitted) this.onSelect(this.entry.sha);
    };

    if (this.showSha) {
      const sha = document.createElement('span');
      sha.className = 'cm-blame-sha';
      sha.textContent = uncommitted ? '·······' : this.entry.shortSha;
      wrap.appendChild(sha);
    }
    const initials = document.createElement('span');
    initials.className = 'cm-blame-initials';
    initials.textContent = uncommitted ? '·' : authorInitials(this.entry.author);
    wrap.appendChild(initials);
    const date = document.createElement('span');
    date.className = 'cm-blame-date';
    date.textContent = uncommitted ? '' : relativeDate(this.entry.authorTime);
    wrap.appendChild(date);
    return wrap;
  }
}

/** Build the gutter extension. Returns an empty array (no extension)
 * when `blame` is empty, which keeps the toggle wiring uniform on the
 * caller side — they always pass the result to the compartment. */
export function blameGutter(
  blame: GitBlameLine[],
  onSelect: (sha: string) => void,
): Extension {
  if (!blame || blame.length === 0) return [];
  // Adjacent identical SHAs hide the SHA pill from the second line
  // onwards — Fork-style; keeps the gutter quieter on long stretches
  // attributed to one commit. Author initials + date still render so
  // the gutter remains usable when scrolled mid-block.
  const byLine = new Map<number, BlameMarker>();
  let prevSha = '';
  for (const entry of blame) {
    const showSha = entry.sha !== prevSha;
    byLine.set(entry.lineNumber, new BlameMarker(entry, showSha, onSelect));
    prevSha = entry.sha;
  }

  return gutter({
    class: 'cm-blame-gutter',
    lineMarker(view: EditorView, lineBlock) {
      const lineNumber = view.state.doc.lineAt(lineBlock.from).number;
      return byLine.get(lineNumber) ?? null;
    },
    // Force a re-render whenever the doc geometry changes (line
    // additions / deletions). Without this CM caches markers per
    // viewport and stale rows can flash through during scroll.
    initialSpacer: () => new BlameMarker(
      { lineNumber: 0, sha: '0'.repeat(40), shortSha: '·······', author: '··', authorTime: '', summary: '' },
      true,
      onSelect,
    ),
  });
}
