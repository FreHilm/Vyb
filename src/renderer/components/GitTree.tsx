import { useEffect, useState, useCallback, useMemo } from 'react';
import { GitCommit, GitRef } from '../../shared/types';
import { buildGraph, GraphRow, maxLane } from '../git-graph';

interface GitTreeProps {
  workingDirectory: string;
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
}

function RefPill({ refData, color }: RefPillProps) {
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
  return (
    <span className="git-tree-ref-wrap" title={refData.tooltip}>
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

export function GitTree({ workingDirectory }: GitTreeProps) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [confirmCheckout, setConfirmCheckout] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, r] = await Promise.all([
        window.api.getGitLog(workingDirectory, COMMIT_LIMIT),
        window.api.getGitRefs(workingDirectory),
      ]);
      setCommits(c);
      setRefs(r);
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    load();
  }, [load]);

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
        <span className="git-tree-count">{commits.length} commits</span>
        <button className="git-changes-btn" onClick={load} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
            <polyline points="13 3 13 6 10 6" />
            <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
            <polyline points="3 13 3 10 6 10" />
          </svg>
        </button>
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

      <div className="git-tree-list">
        {graph.map((row, idx) => {
          const c = commits[idx];
          const rowRefs = refsBySha.get(row.sha) ?? [];
          const isSelected = selectedSha === row.sha;
          const isHead = row.sha === headSha;
          return (
            <div
              key={row.sha}
              className={`git-tree-row${isSelected ? ' git-tree-row-selected' : ''}${isHead ? ' git-tree-row-head' : ''}`}
              onClick={() => setSelectedSha((s) => (s === row.sha ? null : row.sha))}
              onDoubleClick={() => initiateCheckout(row.sha)}
            >
              <RowGraph row={row} laneCount={laneCount} />
              <div className="git-tree-info">
                {rowRefs.map((r) => <RefPill key={r.key} refData={r} color={laneColor(row.lane)} />)}
                <span className="git-tree-subject" title={c.subject}>
                  {c.subject}
                </span>
              </div>
              <span className="git-tree-author" title={`${c.author} <${c.email}>`}>
                {c.author}
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
