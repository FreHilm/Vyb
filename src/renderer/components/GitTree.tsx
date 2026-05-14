import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { GitCommit, GitRef, GitStatus } from '../../shared/types';
import { buildGraph, GraphRow, maxLane } from '../git-graph';
import {
  RefMenuNode, RefContextMenu, useGitRefOps,
} from './git-ref-ops';
import { AuthorAvatar } from './AuthorAvatar';

interface GitTreeProps {
  workingDirectory: string;
  /** Bumped by the parent panel after Push / Pull / Fetch so the tree
   * reloads its commits + refs + status. */
  reloadEpoch?: number;
  /** "Compare with…" handler injected by the panel. The hook builds
   * commit-row compares with `b = sha`, `a = currentBranch || HEAD`. */
  onCompareWith?: (sourceRef: string, sourceLabel: string) => void;
  /** Conflict-file click handler injected by the panel. When set, the
   * conflict-files banner inside `useGitRefOps` renders file names as
   * buttons that open the panel-level conflict resolver overlay. */
  onResolveConflictFile?: (path: string) => void;
  /** T-038: render gravatar avatars in the author column. When false
   * the row keeps the existing text-only author. */
  showAuthorAvatars?: boolean;
}

const ROW_HEIGHT = 28;
const LANE_WIDTH = 14;
const DOT_RADIUS = 4;
const COMMIT_LIMIT = 1000;

// Lane colour cycle. Picked to read on dark + light themes — moderate
// saturation, mid lightness so the dots and lines stay legible against
// both var(--c-base) and the diff backgrounds.
const LANE_COLORS = [
  '#5b9cf2', // blue
  '#f0883e', // orange
  '#a371f7', // purple
  '#56d364', // green
  '#e3b341', // yellow
  '#f78166', // coral
  '#76e4f7', // cyan
  '#db61a2', // pink
];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function relativeDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}

// Branch-fork glyph — used for local refs (and HEAD). Two stacked dots
// connected by a curve, mirroring the icon Fork shows next to branch
// names.
function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6c0 .73-.593 1.25-1.25 1.25H8.25a.75.75 0 00-.75.75v1.378a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836l.015-.008A2.24 2.24 0 018.25 7h3c.14 0 .25-.11.25-.25v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
    </svg>
  );
}

// Generic outline cloud icon — used for any remote-tracking ref. Could
// branch on `remoteUrl` host later for GitHub / GitLab / Bitbucket marks.
function RemoteIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h6a3 3 0 0 0 .4-6 4 4 0 0 0-7.6.7A2.5 2.5 0 0 0 5 12z" />
    </svg>
  );
}

// Tag glyph — used for refs/tags/* labels.
function TagIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 7.5V2.5h5l7 7-5 5-7-7z" />
      <circle cx="5" cy="5" r="0.9" fill="currentColor" />
    </svg>
  );
}

// A pill ready to render — branches and their remote-tracking siblings
// already merged into a single entry, so we get one chip with both
// icons instead of two adjacent chips.
interface DisplayRef {
  /** React key. */
  key: string;
  /** Visible label. */
  name: string;
  /** Newline-joined list of full ref names — feeds the tooltip. */
  tooltip: string;
  hasLocal: boolean;
  hasRemote: boolean;
  isTag: boolean;
  isHead: boolean;
  /** Original GitRef objects this display collapses (one or more). Used
   * by the right-click menu to map back to the matching menu node type. */
  rawRefs: GitRef[];
}

/**
 * Group refs that point at the same commit so a local branch and its
 * remote-tracking equivalent collapse into one pill.
 *
 * Group key = the local branch name. For `refs/remotes/<remote>/<name>`
 * we strip `<remote>/` to find the matching local name. Tags don't
 * group — each is its own pill.
 */
function groupRefs(refs: GitRef[]): DisplayRef[] {
  const tags = refs.filter((r) => r.type === 'tag');
  const branches = refs.filter((r) => r.type === 'local' || r.type === 'remote');

  const branchKey = (r: GitRef): string => {
    if (r.type === 'local') return r.name;
    if (r.type === 'remote' && r.remote) {
      const prefix = r.remote + '/';
      return r.name.startsWith(prefix) ? r.name.slice(prefix.length) : r.name;
    }
    return r.name;
  };

  const groups = new Map<string, GitRef[]>();
  for (const r of branches) {
    const k = branchKey(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  const display: DisplayRef[] = [];

  for (const [key, group] of groups) {
    const local = group.find((r) => r.type === 'local');
    const remotes = group.filter((r) => r.type === 'remote');
    // When there's no local, fall back to the first remote's full name
    // ("origin/feature-x") so it stays disambiguated; with a local we
    // use the bare branch name and the cloud icon signals "also tracked".
    const name = local ? local.name : remotes[0]?.name ?? key;
    display.push({
      key: 'br:' + key,
      name,
      tooltip: group.map((r) => r.fullName).join('\n'),
      hasLocal: !!local,
      hasRemote: remotes.length > 0,
      isTag: false,
      isHead: group.some((r) => r.isHead),
      rawRefs: group,
    });
  }

  for (const t of tags) {
    display.push({
      key: 'tag:' + t.fullName,
      name: t.name,
      tooltip: t.fullName,
      hasLocal: false,
      hasRemote: false,
      isTag: true,
      isHead: false,
      rawRefs: [t],
    });
  }

  // HEAD first, then locals (with or without a remote), then remote-only,
  // then tags — matches Fork's left-to-right reading order.
  display.sort((a, b) => {
    const order = (d: DisplayRef): number =>
      d.isHead ? 0 : !d.isTag && d.hasLocal ? 1 : !d.isTag ? 2 : 3;
    return order(a) - order(b);
  });

  return display;
}

interface RefPillProps {
  refData: DisplayRef;
  color: string;
  /** Right-click handler — only meaningful for branch pills (locals or
   * remote-tracking). Tags ignore it. */
  onContextMenu?: (e: React.MouseEvent, refData: DisplayRef) => void;
}

function RefPill({ refData, color, onContextMenu }: RefPillProps) {
  const cls =
    refData.isHead ? 'git-tree-ref git-tree-ref-head'
    : refData.isTag ? 'git-tree-ref git-tree-ref-tag'
    : 'git-tree-ref git-tree-ref-local';

  // Tags stay neutral; everything else takes the commit's lane colour.
  const style: React.CSSProperties =
    refData.isTag
      ? {}
      : refData.isHead
        ? { background: color, color: 'var(--c-base)', borderColor: color }
        : { color, borderColor: color };

  // Two chips per pill: the in-flow base holds the row's layout slot
  // (truncated with ellipsis), and an absolutely-positioned overlay
  // sits on top of it — hidden until the wrapper is hovered, then it
  // expands to show the full ref name. Keeping the base in flow means
  // hovering doesn't reflow the row.
  const icons = (
    <>
      {refData.isTag && <TagIcon />}
      {!refData.isTag && refData.hasLocal && <BranchIcon />}
      {!refData.isTag && refData.hasRemote && <RemoteIcon />}
    </>
  );
  const handleContextMenu = (e: React.MouseEvent) => {
    if (refData.isTag || !onContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, refData);
  };
  return (
    <span className="git-tree-ref-wrap" title={refData.tooltip} onContextMenu={handleContextMenu}>
      <span className={cls + ' git-tree-ref-base'} style={style}>
        {icons}
        <span className="git-tree-ref-name">{refData.name}</span>
      </span>
      <span className={cls + ' git-tree-ref-overlay'} style={style} aria-hidden>
        {icons}
        <span className="git-tree-ref-name">{refData.name}</span>
      </span>
    </span>
  );
}

interface RowGraphProps {
  row: GraphRow;
  laneCount: number;
}

function RowGraph({ row, laneCount }: RowGraphProps) {
  const w = (laneCount + 1) * LANE_WIDTH;
  const h = ROW_HEIGHT;
  const mid = h / 2;
  const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

  const myLane = row.lane;
  const incomingTerminating = new Set<number>(row.incomingFrom);
  // myLane is incoming if the SHA was already projected into it from above.
  const myWasIncoming = row.lanesBefore[myLane] === row.sha;

  const segments: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];

  // Top half — incoming lines.
  for (let i = 0; i < row.lanesBefore.length; i++) {
    if (row.lanesBefore[i] === null) continue;
    if (i === myLane) {
      if (myWasIncoming) {
        // Continuation into our commit dot.
        segments.push({ x1: x(i), y1: 0, x2: x(i), y2: mid, color: laneColor(i) });
      }
    } else if (incomingTerminating.has(i)) {
      // Diagonal into the commit dot.
      segments.push({ x1: x(i), y1: 0, x2: x(myLane), y2: mid, color: laneColor(i) });
    } else {
      // Pass-through — full row vertical.
      segments.push({ x1: x(i), y1: 0, x2: x(i), y2: h, color: laneColor(i) });
    }
  }

  // Bottom half — outgoing lines to parents.
  // First parent inherits myLane (typical linear continuation).
  for (let p = 0; p < row.outgoingTo.length; p++) {
    const to = row.outgoingTo[p];
    if (to === myLane) {
      segments.push({ x1: x(myLane), y1: mid, x2: x(myLane), y2: h, color: laneColor(myLane) });
    } else {
      segments.push({ x1: x(myLane), y1: mid, x2: x(to), y2: h, color: laneColor(to) });
    }
  }

  return (
    <svg
      className="git-tree-graph"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ flexShrink: 0 }}
    >
      {segments.map((s, idx) => (
        <line
          key={idx}
          x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
          stroke={s.color}
          strokeWidth={2}
          strokeLinecap="round"
        />
      ))}
      <circle
        cx={x(myLane)}
        cy={mid}
        r={DOT_RADIUS}
        fill={laneColor(myLane)}
        stroke="var(--c-base)"
        strokeWidth={1.5}
      />
    </svg>
  );
}

export function GitTree({ workingDirectory, reloadEpoch = 0, onCompareWith, onResolveConflictFile, showAuthorAvatars = true }: GitTreeProps) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [confirmCheckout, setConfirmCheckout] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refMenu, setRefMenu] = useState<{ x: number; y: number; node: RefMenuNode } | null>(null);
  // HEAD-reword dialog. Pre-filled with HEAD's current message; on save
  // runs `gitRewordHead` and reloads. Only opened from the commit menu's
  // "Reword commit message…" item, which is HEAD-only.
  const [rewordDialog, setRewordDialog] = useState<{ subject: string; body: string; busy: boolean; error: string | null } | null>(null);
  // Search state. `query` mirrors the input value live; `appliedQuery`
  // is the debounced value the filter actually uses (150ms delay so
  // typing doesn't make the graph flicker per keystroke).
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, r, s] = await Promise.all([
        window.api.getGitLog(workingDirectory, COMMIT_LIMIT),
        window.api.getGitRefs(workingDirectory),
        window.api.getGitStatus(workingDirectory),
      ]);
      setCommits(c);
      setRefs(r);
      setStatus(s);
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  // Push/Pull/Fetch buttons live in the panel-wide toolbar (see
  // GitChangesPanel). We just need to reload when the parent bumps
  // reloadEpoch, which is wired below.

  // Merge / merge-abort and the in-progress banner are handled by the
  // shared `useGitRefOps` hook below — see its `banner` output rendered
  // above the commit list.

  useEffect(() => {
    load();
    // reloadEpoch bumps every time the parent runs Push / Pull / Fetch.
  }, [load, reloadEpoch]);

  // Debounced search application. Live `query` updates the input
  // immediately; `appliedQuery` is what the filter uses (150ms after
  // the last keystroke).
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  /** Per-commit match predicate. Subject, author name/email, and SHA
   * prefix; case-insensitive substring match. Empty query = always
   * matches (no dimming). Returns null when no query is active so the
   * caller can fast-path.
   *
   * Path filtering ("touches file") was scoped out of v1 because the
   * client-side commit window doesn't carry per-commit file lists yet.
   * The task notes flag it as a future enhancement (`git log --
   * <path>`). */
  const matchesQuery = useCallback((c: GitCommit): boolean => {
    if (!appliedQuery) return true;
    const q = appliedQuery.toLowerCase();
    return (
      c.subject.toLowerCase().includes(q)
      || c.author.toLowerCase().includes(q)
      || (c.email ?? '').toLowerCase().includes(q)
      || c.sha.toLowerCase().startsWith(q)
    );
  }, [appliedQuery]);

  // List of matching SHAs in graph order — used by Enter / Shift+Enter
  // to jump between matches. Recomputed only when commits or the
  // applied query change.
  const matchedShas = useMemo(() => {
    if (!appliedQuery) return [] as string[];
    return commits.filter(matchesQuery).map((c) => c.sha);
  }, [commits, matchesQuery, appliedQuery]);

  // Scroll the row for `sha` into view inside the list. Uses
  // querySelector with a data-attribute we set on each row below.
  const scrollToSha = useCallback((sha: string) => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-sha="${sha}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  // Jump to next / previous match relative to the currently-selected
  // SHA. Wraps around. No-op if there are no matches.
  const jumpMatch = useCallback((direction: 1 | -1) => {
    if (matchedShas.length === 0) return;
    const currentIdx = selectedSha ? matchedShas.indexOf(selectedSha) : -1;
    let next: number;
    if (currentIdx === -1) {
      next = direction === 1 ? 0 : matchedShas.length - 1;
    } else {
      next = (currentIdx + direction + matchedShas.length) % matchedShas.length;
    }
    const target = matchedShas[next];
    setSelectedSha(target);
    scrollToSha(target);
  }, [matchedShas, selectedSha, scrollToSha]);

  // Close the right-click menu on outside mousedown.
  useEffect(() => {
    if (!refMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.file-context-menu')) return;
      setRefMenu(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [refMenu]);

  const graph = useMemo(() => buildGraph(commits), [commits]);
  const laneCount = useMemo(() => maxLane(graph) + 1, [graph]);

  // Group refs by SHA so we can drop them inline next to each commit row.
  // `groupRefs` further collapses local + remote-tracking pairs into one
  // chip per branch (with both icons) instead of two adjacent chips.
  const refsBySha = useMemo(() => {
    const bySha = new Map<string, GitRef[]>();
    for (const r of refs) {
      const arr = bySha.get(r.sha);
      if (arr) arr.push(r);
      else bySha.set(r.sha, [r]);
    }
    const m = new Map<string, DisplayRef[]>();
    for (const [sha, group] of bySha) {
      m.set(sha, groupRefs(group));
    }
    return m;
  }, [refs]);

  // SHA the working copy is currently checked out at — drives the row-level
  // "you are here" marker. The main process synthesises a HEAD pseudo-ref
  // when detached, so this is non-null whenever there's any commit at all.
  const headSha = useMemo(() => {
    const head = refs.find((r) => r.isHead);
    return head?.sha ?? null;
  }, [refs]);

  // Shared menu + dialogs + merge/rebase banners come from the same hook
  // BranchTree uses, so right-click on a ref pill here gets the full
  // operation set (checkout, merge, rebase, push/pull, new branch from,
  // worktree, tracking, rename, copy name, delete, plus PR creation on
  // the current branch).
  const remoteRefs = useMemo(() => refs.filter((r) => r.type === 'remote'), [refs]);
  const currentBranch = status?.branch ?? '';
  const onBranch = !!currentBranch && !/^[0-9a-f]{7,}$/i.test(currentBranch);
  const { ops, modals, banner, errorBar } = useGitRefOps({
    workingDirectory,
    onAfterOp: load,
    remotes: remoteRefs,
    status,
    currentBranch,
    onResolveConflictFile,
  });

  // Wire the HEAD-only Reword action. The menu item is gated on
  // node.isHead so this only triggers from the right commit row.
  const openRewordDialog = useCallback(async () => {
    const head = await window.api.gitHeadInfo(workingDirectory);
    if (!head.ok) return;
    setRewordDialog({
      subject: head.subject ?? '',
      body: head.body ?? '',
      busy: false,
      error: null,
    });
  }, [workingDirectory]);
  const opsWithReword = useMemo(() => ({
    ...ops,
    onReword: openRewordDialog,
    onCompareWith,
  }), [ops, openRewordDialog, onCompareWith]);

  // Convert a DisplayRef (which collapses local + remote-tracking pairs
  // into one chip) to the menu's RefMenuNode shape. When both local and
  // remote sides exist we surface the local side's ops (most common
  // user intent); the Branches tab is the right place to act on the
  // remote-tracking ref specifically.
  const displayToMenuNode = (d: DisplayRef): RefMenuNode | null => {
    if (d.isTag) {
      const t = d.rawRefs.find((r) => r.type === 'tag');
      if (!t) return null;
      return { kind: 'tag', name: t.name, fullName: t.fullName, sha: t.sha };
    }
    if (d.hasLocal) {
      const l = d.rawRefs.find((r) => r.type === 'local');
      if (!l) return null;
      return {
        kind: 'localBranch',
        name: l.name.split('/').pop() ?? l.name,
        fullName: l.name,
        sha: l.sha,
        isHead: l.isHead,
      };
    }
    if (d.hasRemote) {
      const r = d.rawRefs.find((rr) => rr.type === 'remote');
      if (!r || !r.remote) return null;
      const branch = r.name.startsWith(r.remote + '/') ? r.name.slice(r.remote.length + 1) : r.name;
      return {
        kind: 'remoteBranch',
        name: branch.split('/').pop() ?? branch,
        remote: r.remote,
        branch,
        fullName: r.name,
        sha: r.sha,
      };
    }
    return null;
  };

  const runCheckout = useCallback(async (target: string) => {
    setBusy(true);
    setCheckoutError(null);
    try {
      const result = await window.api.gitCheckoutCommit(workingDirectory, target);
      if (!result.ok) {
        setCheckoutError(
          result.error === 'dirty'
            ? 'Working tree has uncommitted changes — commit or stash first.'
            : result.error === 'not-git'
              ? 'Not a git repository.'
              : `Checkout failed: ${result.message ?? 'unknown error'}`,
        );
      } else {
        setConfirmCheckout(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }, [workingDirectory, load]);

  // Decide what to do with a checkout request for a row's SHA:
  //   - already at this commit (it's HEAD) → no-op
  //   - a local branch is at this commit  → switch to that branch directly,
  //     no confirmation needed (we stay attached, not detached)
  //   - otherwise (detached commit)        → confirm via modal
  const initiateCheckout = useCallback((sha: string) => {
    const displays = refsBySha.get(sha) ?? [];
    if (displays.some((d) => d.isHead)) return;
    const localBranch = displays.find((d) => !d.isTag && d.hasLocal);
    if (localBranch) {
      runCheckout(localBranch.name);
      return;
    }
    setConfirmCheckout(sha);
  }, [refsBySha, runCheckout]);

  if (loading && commits.length === 0) {
    return <div className="git-changes-loading">Loading commits…</div>;
  }
  if (commits.length === 0) {
    return <div className="git-changes-empty">No commits</div>;
  }

  return (
    <div className="git-tree">
      <div className="git-tree-toolbar">
        <span className="git-tree-count">
          {commits.length} commits
          {appliedQuery && ` · ${matchedShas.length} match${matchedShas.length === 1 ? '' : 'es'}`}
        </span>
        <input
          ref={searchInputRef}
          type="text"
          className="git-tree-search"
          placeholder="Search subject, author, SHA…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              setAppliedQuery('');
              (e.target as HTMLInputElement).blur();
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              jumpMatch(e.shiftKey ? -1 : 1);
            }
          }}
          spellCheck={false}
        />
      </div>

      {checkoutError && (
        <div className="git-tree-error">
          {checkoutError}
          <button
            className="git-tree-error-close"
            onClick={() => setCheckoutError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Op error + merge/rebase in-progress banners come from the shared hook. */}
      {errorBar}
      {banner}

      {refMenu && (
        <RefContextMenu
          x={refMenu.x}
          y={refMenu.y}
          node={refMenu.node}
          currentBranch={currentBranch}
          onBranch={onBranch}
          onClose={() => setRefMenu(null)}
          {...opsWithReword}
        />
      )}
      {rewordDialog && (
        <div className="modal-overlay" onClick={() => !rewordDialog.busy && setRewordDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Reword commit message</h3></div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                type="text"
                value={rewordDialog.subject}
                onChange={(e) => setRewordDialog((d) => d ? { ...d, subject: e.target.value } : d)}
                placeholder="Subject"
                style={{ width: '100%' }}
                autoFocus
              />
              <textarea
                value={rewordDialog.body}
                onChange={(e) => setRewordDialog((d) => d ? { ...d, body: e.target.value } : d)}
                placeholder="Description (optional)"
                rows={6}
                style={{ width: '100%', fontFamily: 'inherit' }}
              />
              {rewordDialog.error && (
                <div className="git-tree-error">{rewordDialog.error}</div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="cancel-btn"
                disabled={rewordDialog.busy}
                onClick={() => setRewordDialog(null)}
              >
                Cancel
              </button>
              <div className="modal-footer-right">
                <button
                  className="save-btn"
                  disabled={rewordDialog.busy || !rewordDialog.subject.trim()}
                  onClick={async () => {
                    setRewordDialog((d) => d ? { ...d, busy: true, error: null } : d);
                    const result = await window.api.gitRewordHead(workingDirectory, rewordDialog.subject, rewordDialog.body);
                    if (!result.ok) {
                      setRewordDialog((d) => d ? { ...d, busy: false, error: result.message ?? 'reword failed' } : d);
                      return;
                    }
                    setRewordDialog(null);
                    await load();
                  }}
                >
                  {rewordDialog.busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {modals}

      <div className="git-tree-list" ref={listRef}>
        {graph.map((row, idx) => {
          const c = commits[idx];
          const rowRefs = refsBySha.get(row.sha) ?? [];
          const isSelected = selectedSha === row.sha;
          const isHead = row.sha === headSha;
          // When a query is active, non-matching rows dim. Topology is
          // preserved — rows aren't filtered out so the lane lines
          // stay continuous.
          const isDimmed = appliedQuery && !matchesQuery(c);
          return (
            <div
              key={row.sha}
              data-sha={row.sha}
              className={`git-tree-row${isSelected ? ' git-tree-row-selected' : ''}${isHead ? ' git-tree-row-head' : ''}${isDimmed ? ' git-tree-row-dim' : ''}`}
              onClick={() => setSelectedSha((s) => (s === row.sha ? null : row.sha))}
              onDoubleClick={() => initiateCheckout(row.sha)}
              onContextMenu={(e) => {
                // Don't override the ref-pill's own right-click — it has
                // already called stopPropagation. Only fires for the
                // commit row's blank space (graph cell, subject area).
                e.preventDefault();
                setRefMenu({
                  x: e.clientX,
                  y: e.clientY,
                  node: {
                    kind: 'commit',
                    sha: row.sha,
                    shortSha: row.sha.slice(0, 8),
                    subject: c.subject,
                    isHead: row.sha === headSha,
                  },
                });
              }}
            >
              <RowGraph row={row} laneCount={laneCount} />
              <div className="git-tree-info">
                {rowRefs.map((r) => (
                  <RefPill
                    key={r.key}
                    refData={r}
                    color={laneColor(row.lane)}
                    onContextMenu={(e, d) => {
                      const node = displayToMenuNode(d);
                      if (!node) return;
                      setRefMenu({ x: e.clientX, y: e.clientY, node });
                    }}
                  />
                ))}
                <span className="git-tree-subject" title={c.subject}>
                  {c.subject}
                </span>
              </div>
              <span className="git-tree-author" title={`${c.author} <${c.email}>`}>
                {showAuthorAvatars && c.email && (
                  <AuthorAvatar email={c.email} name={c.author} size={16} />
                )}
                <span className="git-tree-author-name">{c.author}</span>
              </span>
              <span className="git-tree-sha" title={c.sha}>{shortSha(c.sha)}</span>
              <span className="git-tree-date" title={c.date}>{relativeDate(c.date)}</span>

              {isSelected && (
                <div className="git-tree-actions">
                  <button
                    className="git-tree-action-btn"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      initiateCheckout(row.sha);
                    }}
                  >
                    Checkout this commit
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmCheckout && (
        <div className="modal-overlay" onClick={() => setConfirmCheckout(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Checkout commit</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Check out <strong>{shortSha(confirmCheckout)}</strong>? This
                puts your working copy in a <em>detached HEAD</em> state — any
                new commits won&apos;t belong to a branch unless you create
                one. Your tracked branches stay where they are.
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button
                  className="cancel-btn"
                  onClick={() => setConfirmCheckout(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  className="save-btn"
                  onClick={() => runCheckout(confirmCheckout)}
                  disabled={busy}
                >
                  {busy ? 'Checking out…' : 'Checkout'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
