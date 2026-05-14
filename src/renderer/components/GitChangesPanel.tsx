import { useEffect, useState, useCallback, useRef } from 'react';
import { FileIcon } from '../file-icons';
import { GitTree } from './GitTree';
import { BranchTree } from './BranchTree';
import { SplitButton, type SplitButtonItem } from './SplitButton';

interface GitChangedFile {
  path: string;
  added: number;
  deleted: number;
  status: string;
  staged: boolean;
}

export type GitPanelTab = 'changes' | 'tree' | 'branches';

interface ChangesCtxMenuState {
  x: number;
  y: number;
  file: GitChangedFile;
}

function ChangesContextMenu({
  state,
  onClose,
  onStageOrUnstage,
  onDiscard,
  onOpen,
}: {
  state: ChangesCtxMenuState;
  onClose: () => void;
  onStageOrUnstage: () => void;
  onDiscard: () => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.file-context-menu')) return;
      onClose();
    };
    window.addEventListener('mousedown', handleDown);
    return () => window.removeEventListener('mousedown', handleDown);
  }, [onClose]);

  const { file } = state;
  return (
    <div className="file-context-menu" style={{ left: state.x, top: state.y }} onClick={(e) => e.stopPropagation()}>
      <button className="file-ctx-item" onClick={onStageOrUnstage}>
        <span className="file-ctx-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            {file.staged ? (
              <>
                <line x1="8" y1="13" x2="8" y2="3" />
                <polyline points="4 7 8 3 12 7" />
              </>
            ) : (
              <>
                <line x1="8" y1="3" x2="8" y2="13" />
                <polyline points="4 9 8 13 12 9" />
              </>
            )}
          </svg>
        </span>
        {file.staged ? 'Unstage' : 'Stage'}
      </button>
      <button className="file-ctx-item" onClick={onOpen}>
        <span className="file-ctx-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6" />
            <path d="M9 2v4h4" />
          </svg>
        </span>
        Open file
      </button>
      <div className="file-ctx-divider" />
      <button className="file-ctx-item file-ctx-danger" onClick={onDiscard}>
        <span className="file-ctx-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 1h5l.5.5V3h3.5v1H13l-.7 10.2a1 1 0 01-1 .8H4.7a1 1 0 01-1-.8L3 4h-.5V3H6V1.5l.5-.5zM6 3h4V2H6v1z" /></svg>
        </span>
        Discard changes
      </button>
    </div>
  );
}

interface GitChangesPanelProps {
  workingDirectory: string;
  onClose: () => void;
  widthPercent: number;
  onWidthChange: (pct: number) => void;
  activeTab: GitPanelTab;
  onTabChange: (tab: GitPanelTab) => void;
  /** Default behaviour for the primary Pull button. 'ask' means primary
   * opens the chevron menu so the user picks each time. */
  pullStrategy?: 'merge' | 'rebase' | 'ask';
  /** What plain Push does about tags by default. The explicit
   * "Push with tags" / "Push reachable tags" dropdown items always
   * use their literal mode, ignoring this. */
  pushTagsStrategy?: 'off' | 'reachable' | 'all';
}

function fileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function fileDir(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

// Parse a unified diff into structured hunks for GitHub-style rendering
interface DiffSegment {
  text: string;
  /** True for the differing words/tokens inside an intra-line diff. */
  changed: boolean;
}
interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'file';
  oldLine: number | null;
  newLine: number | null;
  content: string;
  /** Optional intra-line diff segmentation. When present, renderer
   * uses this in place of `content` so unchanged words stay calm and
   * only the differing words get the strong highlight. */
  segments?: DiffSegment[];
}

// Tokenise a line into words + separators. We split on whitespace AND
// non-alphanumeric runs so symbols are diff-aware too (e.g. swapping
// `===` for `!==` produces three changed tokens, not one mega-token).
function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
      out.push(line.slice(i, j));
      i = j;
    } else if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j++;
      out.push(line.slice(i, j));
      i = j;
    } else {
      // Single non-word, non-space symbol — keep as its own token.
      out.push(ch);
      i++;
    }
  }
  return out;
}

// Standard LCS table over two token arrays. Returns a flat edit script:
// for each step, indicate whether to take from `a`, `b`, or both. Used
// to build the intra-line `segments` arrays for paired del/add lines.
function lcsSegments(a: string, b: string): { delSegs: DiffSegment[]; addSegs: DiffSegment[] } {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const m = ta.length;
  const n = tb.length;
  // Skip the diff for very long lines — `O(m*n)` memory adds up fast.
  if (m * n > 200_000) {
    return {
      delSegs: [{ text: a, changed: true }],
      addSegs: [{ text: b, changed: true }],
    };
  }
  // Build LCS length table.
  const dp: Uint16Array[] = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk it to produce edit script.
  const delSegs: DiffSegment[] = [];
  const addSegs: DiffSegment[] = [];
  const pushSeg = (arr: DiffSegment[], text: string, changed: boolean) => {
    if (arr.length > 0 && arr[arr.length - 1].changed === changed) {
      arr[arr.length - 1].text += text;
    } else {
      arr.push({ text, changed });
    }
  };
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (ta[i] === tb[j]) {
      pushSeg(delSegs, ta[i], false);
      pushSeg(addSegs, tb[j], false);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg(delSegs, ta[i], true);
      i++;
    } else {
      pushSeg(addSegs, tb[j], true);
      j++;
    }
  }
  while (i < m) { pushSeg(delSegs, ta[i++], true); }
  while (j < n) { pushSeg(addSegs, tb[j++], true); }
  return { delSegs, addSegs };
}

// After parsing the unified diff, walk and pair adjacent runs of
// `del` followed by `add` of equal length so we can fill in
// `line.segments` for each pair. Heuristic: pair index-by-index inside
// the matched run; unbalanced extras fall back to whole-line highlight.
function annotateIntraLineDiffs(lines: DiffLine[]): void {
  let k = 0;
  while (k < lines.length) {
    // Find a run of `del` lines.
    let dStart = k;
    while (dStart < lines.length && lines[dStart].type !== 'del') dStart++;
    if (dStart >= lines.length) break;
    let dEnd = dStart;
    while (dEnd < lines.length && lines[dEnd].type === 'del') dEnd++;
    // Now look for an immediately-following run of `add` lines.
    let aStart = dEnd;
    let aEnd = aStart;
    while (aEnd < lines.length && lines[aEnd].type === 'add') aEnd++;
    const dCount = dEnd - dStart;
    const aCount = aEnd - aStart;
    const pairs = Math.min(dCount, aCount);
    for (let p = 0; p < pairs; p++) {
      const del = lines[dStart + p];
      const add = lines[aStart + p];
      const { delSegs, addSegs } = lcsSegments(del.content, add.content);
      // Only annotate when SOME tokens are unchanged — otherwise the
      // intraline highlight is just "everything", no improvement over
      // the plain line background.
      const someUnchanged = delSegs.some((s) => !s.changed) || addSegs.some((s) => !s.changed);
      if (someUnchanged) {
        del.segments = delSegs;
        add.segments = addSegs;
      }
    }
    k = aEnd > k ? aEnd : k + 1;
  }
}

function parseDiff(diff: string): DiffLine[] {
  const result: DiffLine[] = [];
  const lines = diff.split('\n');
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ')) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      result.push({ type: 'hunk', oldLine: null, newLine: null, content: line });
      continue;
    }
    if (line.startsWith('+')) {
      result.push({ type: 'add', oldLine: null, newLine: newLine++, content: line.slice(1) });
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', oldLine: oldLine++, newLine: null, content: line.slice(1) });
    } else if (line.startsWith(' ')) {
      result.push({ type: 'ctx', oldLine: oldLine++, newLine: newLine++, content: line.slice(1) });
      // Note: Context increments both counters
    }
    // Ignore \ No newline at end of file etc.
  }
  // Compute intra-line word-level diffs for paired del/add lines so the
  // renderer can highlight just the differing tokens instead of marking
  // whole lines as solid red/green.
  annotateIntraLineDiffs(result);
  return result;
}

function FileDiff({ diff }: { diff: string }) {
  const lines = parseDiff(diff);
  if (lines.length === 0) {
    return <div className="git-diff-empty">No diff available</div>;
  }
  return (
    <div className="git-diff">
      {lines.map((line, idx) => {
        if (line.type === 'hunk') {
          return (
            <div key={idx} className="git-diff-hunk">
              <span className="git-diff-gutter" />
              <span className="git-diff-gutter" />
              <code className="git-diff-content">{line.content}</code>
            </div>
          );
        }
        const cls = line.type === 'add' ? 'git-diff-add' : line.type === 'del' ? 'git-diff-del' : 'git-diff-ctx';
        return (
          <div key={idx} className={`git-diff-line ${cls}`}>
            <span className="git-diff-gutter">{line.oldLine ?? ''}</span>
            <span className="git-diff-gutter">{line.newLine ?? ''}</span>
            <code className="git-diff-content">
              {line.segments
                ? line.segments.map((seg, sIdx) => (
                    <span key={sIdx} className={seg.changed ? 'git-diff-word' : undefined}>
                      {seg.text}
                    </span>
                  ))
                : line.content}
            </code>
          </div>
        );
      })}
    </div>
  );
}

export function GitChangesPanel({ workingDirectory, onClose, widthPercent, onWidthChange, activeTab, onTabChange, pullStrategy = 'merge', pushTagsStrategy = 'off' }: GitChangesPanelProps) {
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [commitSubject, setCommitSubject] = useState('');
  const [commitDescription, setCommitDescription] = useState('');
  const [commitBusy, setCommitBusy] = useState(false);
  // Amend mode: next commit folds into HEAD via `git commit --amend`
  // instead of creating a fresh commit. We track HEAD info so the UI can
  // pre-fill the subject + description when amend turns on, and warn
  // when the HEAD has already been pushed (rewriting public history).
  const [amendMode, setAmendMode] = useState(false);
  const [headInfo, setHeadInfo] = useState<{ subject: string; body: string; pushed: boolean; sha: string } | null>(null);
  // Captured commit fields from BEFORE amend mode was switched on, so
  // we can restore them if the user toggles amend off without committing.
  const preAmendDraftRef = useRef<{ subject: string; description: string } | null>(null);
  // Confirm dialog for "this would rewrite history that's been pushed".
  const [amendConfirmOpen, setAmendConfirmOpen] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ChangesCtxMenuState | null>(null);
  const [discardTarget, setDiscardTarget] = useState<GitChangedFile | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Shared status (branch + ahead/behind + remoteUrl) shown in the
  // panel-wide toolbar — drives the Pull / Push enabled state.
  const [status, setStatus] = useState<{ branch: string; ahead: number; behind: number; remoteUrl: string | null } | null>(null);
  // In-flight remote op label so we can dim the relevant button.
  const [syncing, setSyncing] = useState<null | 'push' | 'pull' | 'fetch'>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Bumps after any remote op (push/pull/fetch) to force the active
  // sub-tab (Tree / Branches) to reload. ChangesView reloads via its
  // own `reloadFiles`; Tree + BranchTree pick this up as a useEffect dep.
  const [reloadEpoch, setReloadEpoch] = useState(0);

  const loadStatus = useCallback(async () => {
    try {
      const s = await window.api.getGitStatus(workingDirectory);
      setStatus(s ? {
        branch: s.branch,
        ahead: s.ahead ?? 0,
        behind: s.behind ?? 0,
        remoteUrl: s.remoteUrl ?? null,
      } : null);
    } catch {
      setStatus(null);
    }
    // Refresh HEAD info alongside status — drives the Amend pre-fill +
    // the "rewrites public history" warning.
    try {
      const h = await window.api.gitHeadInfo(workingDirectory);
      if (h.ok) {
        setHeadInfo({
          subject: h.subject ?? '',
          body: h.body ?? '',
          pushed: h.pushed === true,
          sha: h.sha ?? '',
        });
      } else {
        setHeadInfo(null);
      }
    } catch {
      setHeadInfo(null);
    }
  }, [workingDirectory]);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.api.getGitChangedFiles(workingDirectory);
    setFiles(result);
    setLoading(false);
    loadStatus();
  }, [workingDirectory, loadStatus]);

  useEffect(() => {
    load();
  }, [load]);

  // Push / Pull / Fetch — shared across all three tabs. Each bumps the
  // reload epoch so the active sub-view re-fetches its data.
  const runPushVariant = useCallback(async (tagMode: 'off' | 'reachable' | 'all') => {
    if (syncing) return;
    setSyncing('push');
    setSyncError(null);
    try {
      const result = await window.api.gitPush(workingDirectory, tagMode);
      if (!result.ok) setSyncError(result.message ?? 'push failed');
      await loadStatus();
      setReloadEpoch((n) => n + 1);
    } finally {
      setSyncing(null);
    }
  }, [workingDirectory, syncing, loadStatus]);

  const handlePush = useCallback(() => runPushVariant(pushTagsStrategy), [runPushVariant, pushTagsStrategy]);

  const runPullVariant = useCallback(async (kind: 'merge' | 'rebase') => {
    if (syncing) return;
    setSyncing('pull');
    setSyncError(null);
    try {
      const result = kind === 'rebase'
        ? await window.api.gitPullRebase(workingDirectory)
        : await window.api.gitPull(workingDirectory);
      if (!result.ok) setSyncError(result.message ?? `${kind} pull failed`);
      await loadStatus();
      await load();
      setReloadEpoch((n) => n + 1);
    } finally {
      setSyncing(null);
    }
  }, [workingDirectory, syncing, loadStatus, load]);

  const handlePull = useCallback(() => runPullVariant('merge'), [runPullVariant]);
  const handlePullRebase = useCallback(() => runPullVariant('rebase'), [runPullVariant]);

  // Force-push (with lease) confirmation. Opening sets this; the modal
  // surfaces the branch + upstream SHA so the user can sanity-check.
  const [forcePushConfirm, setForcePushConfirm] = useState<{ branch: string; ahead: number; behind: number } | null>(null);
  const runForcePush = useCallback(async () => {
    if (syncing) return;
    setSyncing('push');
    setSyncError(null);
    try {
      const result = await window.api.gitPushForceLease(workingDirectory);
      if (!result.ok) setSyncError(result.message ?? 'force-push failed');
      await loadStatus();
      setReloadEpoch((n) => n + 1);
    } finally {
      setSyncing(null);
    }
  }, [workingDirectory, syncing, loadStatus]);

  const handleFetch = useCallback(async () => {
    if (syncing) return;
    setSyncing('fetch');
    setSyncError(null);
    try {
      await window.api.gitFetch(workingDirectory);
      await loadStatus();
      setReloadEpoch((n) => n + 1);
    } finally {
      setSyncing(null);
    }
  }, [workingDirectory, syncing, loadStatus]);

  // Files can appear once on either side (or, when partial-staging lands,
  // both). Key the expanded set + diff cache by `${staged}|${path}` so the
  // same path on both sides is independent.
  const rowKey = (path: string, staged: boolean): string => `${staged ? 's' : 'u'}|${path}`;

  const toggleFile = useCallback(async (path: string, staged: boolean) => {
    const key = rowKey(path, staged);
    if (expanded.has(key)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    if (!diffs.has(key)) {
      const diff = await window.api.getGitFileDiff(workingDirectory, path, staged);
      setDiffs((prev) => new Map(prev).set(key, diff));
    }
    setExpanded((prev) => new Set(prev).add(key));
  }, [expanded, diffs, workingDirectory]);

  // Soft refresh — refetches the file list without toggling `loading` (so
  // the existing list stays on screen instead of being replaced by
  // "Loading..."), and without clearing expanded/diff state. Used after
  // stage/unstage/commit to reconcile the optimistic update with truth.
  const reloadFiles = useCallback(async () => {
    const result = await window.api.getGitChangedFiles(workingDirectory);
    setFiles(result);
  }, [workingDirectory]);

  // Optimistically flip the `staged` flag locally so the row jumps
  // immediately to the other section, then call git in the background and
  // reconcile. The IPC + reload still runs to catch edge cases (the file
  // dropping out, counts changing, etc.) but the visible list never blanks.
  const stageOne = useCallback(async (path: string) => {
    setFiles((prev) => prev.map((f) => f.path === path && !f.staged ? { ...f, staged: true } : f));
    await window.api.gitStage(workingDirectory, path);
    await reloadFiles();
  }, [workingDirectory, reloadFiles]);

  const unstageOne = useCallback(async (path: string) => {
    setFiles((prev) => prev.map((f) => f.path === path && f.staged ? { ...f, staged: false } : f));
    await window.api.gitUnstage(workingDirectory, path);
    await reloadFiles();
  }, [workingDirectory, reloadFiles]);

  const stageAll = useCallback(async (paths: string[]) => {
    const set = new Set(paths);
    setFiles((prev) => prev.map((f) => set.has(f.path) && !f.staged ? { ...f, staged: true } : f));
    for (const p of paths) await window.api.gitStage(workingDirectory, p);
    await reloadFiles();
  }, [workingDirectory, reloadFiles]);

  const unstageAll = useCallback(async (paths: string[]) => {
    const set = new Set(paths);
    setFiles((prev) => prev.map((f) => set.has(f.path) && f.staged ? { ...f, staged: false } : f));
    for (const p of paths) await window.api.gitUnstage(workingDirectory, p);
    await reloadFiles();
  }, [workingDirectory, reloadFiles]);

  // Shared commit / amend execution. `kind = 'amend'` folds staged work
  // into HEAD via `git commit --amend`; `kind = 'commit'` creates a new
  // commit as before. Both consult the local subject+description.
  const runCommitOrAmend = useCallback(async (kind: 'commit' | 'amend') => {
    if (!commitSubject.trim() || commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      const result = kind === 'amend'
        ? await window.api.gitAmendCommit(workingDirectory, commitSubject, commitDescription)
        : await window.api.gitCommit(workingDirectory, commitSubject, commitDescription);
      if (!result.ok) {
        setCommitError(result.message ?? `${kind} failed`);
      } else {
        setCommitSubject('');
        setCommitDescription('');
        setFiles((prev) => prev.filter((f) => !f.staged));
        if (kind === 'amend') {
          setAmendMode(false);
          preAmendDraftRef.current = null;
        }
        await reloadFiles();
        await loadStatus();
        setReloadEpoch((n) => n + 1);
      }
    } finally {
      setCommitBusy(false);
    }
  }, [workingDirectory, commitSubject, commitDescription, commitBusy, reloadFiles, loadStatus]);

  const handleCommit = useCallback(async () => {
    if (amendMode) {
      // Surface a confirm dialog when the HEAD we're about to rewrite
      // has already been pushed — fork-style "this rewrites public
      // history" warning. Skip the dialog otherwise for a one-click amend.
      if (headInfo?.pushed) {
        setAmendConfirmOpen(true);
        return;
      }
      await runCommitOrAmend('amend');
      return;
    }
    await runCommitOrAmend('commit');
  }, [amendMode, headInfo, runCommitOrAmend]);

  // Toggle amend mode. Turning on pre-fills the subject + description
  // from HEAD (after stashing the user's in-progress draft); turning off
  // restores the draft so toggling is non-destructive.
  const toggleAmendMode = useCallback(() => {
    setAmendMode((wasOn) => {
      const turningOn = !wasOn;
      if (turningOn) {
        if (!headInfo) return wasOn; // no HEAD yet — refuse silently
        preAmendDraftRef.current = { subject: commitSubject, description: commitDescription };
        setCommitSubject(headInfo.subject);
        setCommitDescription(headInfo.body);
      } else {
        const restore = preAmendDraftRef.current;
        if (restore) {
          setCommitSubject(restore.subject);
          setCommitDescription(restore.description);
        }
        preAmendDraftRef.current = null;
      }
      return turningOn;
    });
  }, [commitSubject, commitDescription, headInfo]);

  const openContextMenu = useCallback((e: React.MouseEvent, file: GitChangedFile) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, file });
  }, []);

  const openFileInExplorer = useCallback((file: GitChangedFile) => {
    setCtxMenu(null);
    // The file path is repo-relative; the global open-file-in-explorer
    // handler in App.tsx switches to the Files tab and opens an absolute
    // path, so we join with the working directory here.
    const abs = workingDirectory.replace(/\/$/, '') + '/' + file.path;
    window.dispatchEvent(new CustomEvent('open-file-in-explorer', { detail: { path: abs } }));
  }, [workingDirectory]);

  const confirmDiscard = useCallback((file: GitChangedFile) => {
    setCtxMenu(null);
    setDiscardTarget(file);
  }, []);

  const runDiscard = useCallback(async () => {
    if (!discardTarget) return;
    const target = discardTarget;
    setDiscardTarget(null);
    // Optimistic: drop the row from local state so the UI feels snappy.
    // The post-discard reload reconciles (e.g. if discard failed the file
    // reappears).
    setFiles((prev) => prev.filter((f) => f.path !== target.path || f.staged !== target.staged));
    await window.api.gitDiscardFile(workingDirectory, target.path, target.status === 'untracked');
    await reloadFiles();
  }, [discardTarget, workingDirectory, reloadFiles]);

  // Resize handle drag logic
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthPercent;
    const parent = panelRef.current?.parentElement;
    if (!parent) return;
    const parentWidth = parent.clientWidth;

    const handleMove = (ev: MouseEvent) => {
      // Dragging left = wider panel (since panel is on right)
      const delta = startX - ev.clientX;
      const deltaPct = (delta / parentWidth) * 100;
      const next = Math.max(20, Math.min(80, startWidth + deltaPct));
      onWidthChange(next);
    };

    const handleUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [widthPercent, onWidthChange]);

  return (
    <div
      className="git-changes-panel"
      ref={panelRef}
      style={{ width: `${widthPercent}%` }}
    >
      <div className="git-changes-resize" onMouseDown={handleResizeStart} />
      <div className="git-changes-header git-panel-tabs">
        <div className="git-panel-tab-row">
          <button
            className={`git-panel-tab ${activeTab === 'changes' ? 'git-panel-tab-active' : ''}`}
            onClick={() => onTabChange('changes')}
          >
            Changes{!loading && activeTab === 'changes' ? ` (${files.length})` : ''}
          </button>
          <button
            className={`git-panel-tab ${activeTab === 'tree' ? 'git-panel-tab-active' : ''}`}
            onClick={() => onTabChange('tree')}
          >
            Tree
          </button>
          <button
            className={`git-panel-tab ${activeTab === 'branches' ? 'git-panel-tab-active' : ''}`}
            onClick={() => onTabChange('branches')}
          >
            Branches
          </button>
        </div>
        <div className="git-changes-actions">
          <button className="git-changes-btn" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Unified status / sync toolbar — shown across all three tabs.
          Surfaces the current branch + ahead/behind and the remote
          operations (Pull / Push / Fetch). Refresh reloads whichever
          tab is active. */}
      {(() => {
        const onBranch = !!status?.branch && !/^[0-9a-f]{7,}$/i.test(status.branch);
        const ahead = status?.ahead ?? 0;
        const behind = status?.behind ?? 0;
        const hasUpstream = ahead > 0 || behind > 0;
        const pushEnabled = onBranch && (ahead > 0 || (!hasUpstream && !!status?.remoteUrl));
        const pullEnabled = onBranch && behind > 0;
        const pushTip = !onBranch
          ? 'Detached HEAD — checkout a branch to push'
          : ahead > 0
            ? `Push ${ahead} commit${ahead === 1 ? '' : 's'} to origin`
            : !hasUpstream
              ? `Publish branch "${status?.branch}" to origin`
              : 'Nothing to push';
        const pullTip = !onBranch
          ? 'Detached HEAD — checkout a branch to pull'
          : behind > 0
            ? `Pull ${behind} commit${behind === 1 ? '' : 's'} from origin`
            : 'Up to date';
        return (
          <div className="git-panel-statusbar">
            <span className="git-panel-statusbar-branch" title={status?.branch ?? ''}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4" cy="3.5" r="1.4" />
                <circle cx="4" cy="12.5" r="1.4" />
                <circle cx="12" cy="6" r="1.4" />
                <line x1="4" y1="4.9" x2="4" y2="11.1" />
                <path d="M12 7.4v.6a3 3 0 0 1-3 3H7" />
              </svg>
              <span>{status?.branch ?? '—'}</span>
            </span>
            <span className="git-panel-statusbar-counts">
              {ahead > 0 && <span title={`${ahead} commit${ahead === 1 ? '' : 's'} ahead of origin`}>↑{ahead}</span>}
              {behind > 0 && <span title={`${behind} commit${behind === 1 ? '' : 's'} behind origin`}>↓{behind}</span>}
            </span>
            <div className="git-panel-statusbar-spacer" />
            {(() => {
              const primary = pullStrategy === 'rebase' ? handlePullRebase : handlePull;
              const primaryLabel = pullStrategy === 'rebase' ? 'Pull (rebase)' : 'Pull';
              // 'ask' mode: the primary button is left without a default
              // action — the user has to use the chevron. We keep it
              // labelled "Pull" but disabled with a hint.
              const ask = pullStrategy === 'ask';
              return (
                <SplitButton
                  className={`git-panel-statusbar-btn ${syncing === 'pull' ? 'is-busy' : ''}`}
                  label={ask ? 'Pull…' : primaryLabel}
                  onClick={ask ? () => undefined : primary}
                  disabled={!pullEnabled || syncing !== null || ask}
                  title={ask ? 'Pick a pull strategy from the dropdown' : pullTip}
                  busy={syncing === 'pull'}
                  icon={(
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="8" y1="2" x2="8" y2="11" />
                      <polyline points="4 7 8 11 12 7" />
                      <line x1="3" y1="14" x2="13" y2="14" />
                    </svg>
                  )}
                  badge={behind > 0 ? <span className="git-panel-statusbar-badge">{behind}</span> : undefined}
                  items={[
                    {
                      label: 'Pull (merge)',
                      hint: 'git pull — adds a merge commit if needed',
                      disabled: !pullEnabled || syncing !== null,
                      onClick: handlePull,
                    },
                    {
                      label: 'Pull (rebase)',
                      hint: 'git pull --rebase — replays local commits on top',
                      disabled: !pullEnabled || syncing !== null,
                      onClick: handlePullRebase,
                    },
                  ]}
                />
              );
            })()}
            {(() => {
              // Force-with-lease is only safe — and useful — when local
              // history has actually diverged from upstream (we have
              // commits to push AND the upstream has commits we don't).
              // This is the classic "amended a published commit" shape.
              const diverged = onBranch && ahead > 0 && behind > 0;
              const forceItem: SplitButtonItem = {
                label: 'Force push (with lease)',
                hint: diverged
                  ? `Replace upstream ${status?.branch ?? ''} with local (lease-guarded)`
                  : !onBranch
                    ? 'Detached HEAD — checkout a branch first'
                    : 'No diverged history — plain push suffices',
                disabled: !diverged || syncing !== null,
                danger: true,
                onClick: () => setForcePushConfirm({
                  branch: status?.branch ?? '',
                  ahead,
                  behind,
                }),
              };
              const reachableTagsItem: SplitButtonItem = {
                label: 'Push (with reachable tags)',
                hint: 'git push --follow-tags — annotated tags reachable from the pushed commits',
                disabled: !pushEnabled || syncing !== null,
                onClick: () => runPushVariant('reachable'),
              };
              const allTagsItem: SplitButtonItem = {
                label: 'Push (with all tags)',
                hint: 'git push --tags — every local tag (may fail on existing remote tags)',
                disabled: !pushEnabled || syncing !== null,
                onClick: () => runPushVariant('all'),
              };
              return (
                <SplitButton
                  className={`git-panel-statusbar-btn ${syncing === 'push' ? 'is-busy' : ''}`}
                  label="Push"
                  onClick={handlePush}
                  disabled={!pushEnabled || syncing !== null}
                  title={pushTip}
                  busy={syncing === 'push'}
                  icon={(
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="3" y1="2" x2="13" y2="2" />
                      <line x1="8" y1="5" x2="8" y2="14" />
                      <polyline points="4 9 8 5 12 9" />
                    </svg>
                  )}
                  badge={ahead > 0 ? <span className="git-panel-statusbar-badge">{ahead}</span> : undefined}
                  items={[reachableTagsItem, allTagsItem, forceItem]}
                />
              );
            })()}
            <button
              className={`git-panel-statusbar-btn ${syncing === 'fetch' ? 'is-busy' : ''}`}
              onClick={handleFetch}
              disabled={syncing !== null || !status?.remoteUrl}
              title={status?.remoteUrl ? 'Fetch from origin' : 'No remote configured'}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
                <polyline points="13 3 13 6 10 6" />
                <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
                <polyline points="3 13 3 10 6 10" />
              </svg>
              <span>Fetch</span>
            </button>
            <button
              className="git-panel-statusbar-btn"
              onClick={() => { load(); setReloadEpoch((n) => n + 1); }}
              disabled={syncing !== null}
              title="Refresh local view"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 4 3 8 7 8" />
                <path d="M3 8a5 5 0 1 1 1.5 3.5" />
              </svg>
            </button>
          </div>
        );
      })()}
      {syncError && (
        <div className="git-panel-statusbar-error">
          <span>{syncError}</span>
          <button className="git-commit-error-close" onClick={() => setSyncError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {activeTab === 'tree' ? (
        <div className="git-changes-body">
          <GitTree workingDirectory={workingDirectory} reloadEpoch={reloadEpoch} />
        </div>
      ) : activeTab === 'branches' ? (
        <div className="git-changes-body">
          <BranchTree workingDirectory={workingDirectory} reloadEpoch={reloadEpoch} />
        </div>
      ) : (
        <ChangesView
          loading={loading}
          files={files}
          expanded={expanded}
          diffs={diffs}
          onToggle={toggleFile}
          onStageOne={stageOne}
          onUnstageOne={unstageOne}
          onStageAll={stageAll}
          onUnstageAll={unstageAll}
          onContextMenu={openContextMenu}
          rowKey={rowKey}
          commitSubject={commitSubject}
          commitDescription={commitDescription}
          commitBusy={commitBusy}
          commitError={commitError}
          onCommitSubjectChange={setCommitSubject}
          onCommitDescriptionChange={setCommitDescription}
          onCommit={handleCommit}
          onDismissCommitError={() => setCommitError(null)}
          amendMode={amendMode}
          amendAvailable={!!headInfo}
          amendPushed={headInfo?.pushed === true}
          onToggleAmend={toggleAmendMode}
        />
      )}
      {forcePushConfirm && (
        <div className="modal-overlay" onClick={() => setForcePushConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Force-push with lease?</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Replace <strong>origin/{forcePushConfirm.branch}</strong> with
                your local <strong>{forcePushConfirm.branch}</strong>.
              </p>
              <p style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.75, marginTop: 8 }}>
                Local has {forcePushConfirm.ahead} commit{forcePushConfirm.ahead === 1 ? '' : 's'} to push,
                upstream has {forcePushConfirm.behind} commit{forcePushConfirm.behind === 1 ? '' : 's'} you don't have —
                they'll be replaced.
              </p>
              <p style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.75, marginTop: 6 }}>
                <code>--force-with-lease</code> will refuse if someone has pushed since the last fetch.
              </p>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={() => setForcePushConfirm(null)}>Cancel</button>
              <div className="modal-footer-right">
                <button
                  className="delete-btn"
                  onClick={async () => {
                    setForcePushConfirm(null);
                    await runForcePush();
                  }}
                >
                  Force push
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {amendConfirmOpen && (
        <div className="modal-overlay" onClick={() => setAmendConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Rewrite pushed commit?</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                The current HEAD ({headInfo?.sha?.slice(0, 7)}) has already
                been pushed to a remote. Amending will rewrite history —
                anyone who has pulled this commit will need to reset.
              </p>
              <p style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.75, marginTop: 8 }}>
                You'll likely need a force-push (with lease) afterwards.
              </p>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={() => setAmendConfirmOpen(false)}>Cancel</button>
              <div className="modal-footer-right">
                <button
                  className="delete-btn"
                  onClick={async () => {
                    setAmendConfirmOpen(false);
                    await runCommitOrAmend('amend');
                  }}
                >
                  Amend anyway
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {ctxMenu && (
        <ChangesContextMenu
          state={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onStageOrUnstage={() => {
            const f = ctxMenu.file;
            setCtxMenu(null);
            if (f.staged) unstageOne(f.path); else stageOne(f.path);
          }}
          onDiscard={() => confirmDiscard(ctxMenu.file)}
          onOpen={() => openFileInExplorer(ctxMenu.file)}
        />
      )}
      {discardTarget && (
        <div className="modal-overlay" onClick={() => setDiscardTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Discard changes</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Discard local changes to <strong>{discardTarget.path}</strong>?
                {discardTarget.status === 'untracked'
                  ? ' This will delete the file from disk.'
                  : ' This will revert the file to its HEAD state.'}
                <br /><span style={{ opacity: 0.6 }}>This cannot be undone.</span>
              </p>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={() => setDiscardTarget(null)}>Cancel</button>
              <div className="modal-footer-right">
                <button className="delete-btn" onClick={runDiscard}>Discard</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab body: Unstaged + Staged sections + commit area ─────────────

interface ChangesViewProps {
  loading: boolean;
  files: GitChangedFile[];
  expanded: Set<string>;
  diffs: Map<string, string>;
  onToggle: (path: string, staged: boolean) => void;
  onStageOne: (path: string) => void;
  onUnstageOne: (path: string) => void;
  onStageAll: (paths: string[]) => void;
  onUnstageAll: (paths: string[]) => void;
  onContextMenu: (e: React.MouseEvent, file: GitChangedFile) => void;
  rowKey: (path: string, staged: boolean) => string;
  commitSubject: string;
  commitDescription: string;
  commitBusy: boolean;
  commitError: string | null;
  onCommitSubjectChange: (s: string) => void;
  onCommitDescriptionChange: (s: string) => void;
  onCommit: () => void;
  onDismissCommitError: () => void;
  /** When true the commit area is in amend mode — the action button
   * folds staged changes into HEAD instead of creating a new commit. */
  amendMode: boolean;
  /** Whether HEAD exists at all (false on an empty repo). Disables the
   * Amend checkbox in that case. */
  amendAvailable: boolean;
  /** Whether HEAD has been pushed to a remote — surfaces a warning
   * subtext in amend mode. */
  amendPushed: boolean;
  onToggleAmend: () => void;
}

function ChangesView({
  loading,
  files,
  expanded,
  diffs,
  onToggle,
  onStageOne,
  onUnstageOne,
  onStageAll,
  onUnstageAll,
  onContextMenu,
  rowKey,
  commitSubject,
  commitDescription,
  commitBusy,
  commitError,
  onCommitSubjectChange,
  onCommitDescriptionChange,
  onCommit,
  onDismissCommitError,
  amendMode,
  amendAvailable,
  amendPushed,
  onToggleAmend,
}: ChangesViewProps) {
  const unstaged = files.filter((f) => !f.staged);
  const staged = files.filter((f) => f.staged);
  // In amend mode the commit area becomes usable even with no staged
  // files (a pure message-rewrite). Out of amend mode we still require
  // staged content as before.
  const canCommit = commitSubject.trim().length > 0 && !commitBusy && (amendMode || staged.length > 0);

  return (
    <div className="git-changes-split">
      <div className="git-changes-list">
        {loading && <div className="git-changes-loading">Loading...</div>}
        {!loading && files.length === 0 && (
          <div className="git-changes-empty">No changes</div>
        )}

        {!loading && (unstaged.length > 0 || staged.length === 0) && (
          <FileSection
            title="Changes"
            count={unstaged.length}
            files={unstaged}
            staged={false}
            expanded={expanded}
            diffs={diffs}
            onToggle={onToggle}
            onMove={onStageOne}
            onMoveAll={() => onStageAll(unstaged.map((f) => f.path))}
            onContextMenu={onContextMenu}
            rowKey={rowKey}
          />
        )}

        {!loading && staged.length > 0 && (
          <FileSection
            title="Staged"
            count={staged.length}
            files={staged}
            staged={true}
            expanded={expanded}
            diffs={diffs}
            onToggle={onToggle}
            onMove={onUnstageOne}
            onMoveAll={() => onUnstageAll(staged.map((f) => f.path))}
            onContextMenu={onContextMenu}
            rowKey={rowKey}
          />
        )}
      </div>

      <div className="git-commit-area">
        {commitError && (
          <div className="git-commit-error">
            <span>{commitError}</span>
            <button className="git-commit-error-close" onClick={onDismissCommitError} aria-label="Dismiss">×</button>
          </div>
        )}
        <input
          className="git-commit-subject"
          type="text"
          placeholder="Subject"
          value={commitSubject}
          onChange={(e) => onCommitSubjectChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) onCommit();
          }}
        />
        <textarea
          className="git-commit-description"
          placeholder="Description (optional)"
          value={commitDescription}
          onChange={(e) => onCommitDescriptionChange(e.target.value)}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) onCommit();
          }}
        />
        <div className="git-commit-amend-row">
          <label
            className={`git-commit-amend-toggle ${amendAvailable ? '' : 'is-disabled'}`}
            title={amendAvailable ? 'Fold staged changes into the last commit' : 'No HEAD yet — make the first commit normally'}
          >
            <input
              type="checkbox"
              checked={amendMode}
              disabled={!amendAvailable}
              onChange={onToggleAmend}
            />
            <span>Amend last commit</span>
          </label>
          {amendMode && amendPushed && (
            <span className="git-commit-amend-warning" title="HEAD has been pushed — amending rewrites public history.">
              ⚠ pushed
            </span>
          )}
        </div>
        <button
          className="git-commit-btn"
          disabled={!canCommit}
          onClick={onCommit}
          title={
            !commitSubject.trim()
              ? 'Enter a subject'
              : !amendMode && staged.length === 0
                ? 'Stage a file first'
                : amendMode
                  ? 'Amend HEAD (⌘↵)'
                  : 'Commit (⌘↵)'
          }
        >
          {commitBusy
            ? (amendMode ? 'Amending…' : 'Committing…')
            : amendMode
              ? (staged.length === 0
                  ? 'Amend message'
                  : `Amend ${staged.length} ${staged.length === 1 ? 'file' : 'files'} into HEAD`)
              : `Commit ${staged.length} ${staged.length === 1 ? 'file' : 'files'}`}
        </button>
      </div>
    </div>
  );
}

interface FileSectionProps {
  title: string;
  count: number;
  files: GitChangedFile[];
  staged: boolean;
  expanded: Set<string>;
  diffs: Map<string, string>;
  onToggle: (path: string, staged: boolean) => void;
  onMove: (path: string) => void;
  onMoveAll: () => void;
  onContextMenu: (e: React.MouseEvent, file: GitChangedFile) => void;
  rowKey: (path: string, staged: boolean) => string;
}

function FileSection({
  title, count, files, staged, expanded, diffs, onToggle, onMove, onMoveAll, onContextMenu, rowKey,
}: FileSectionProps) {
  return (
    <div className="git-changes-section">
      <div className="git-changes-section-header">
        <span className="git-changes-section-title">{title} ({count})</span>
        {count > 0 && (
          <button
            className="git-changes-section-action"
            onClick={onMoveAll}
            title={staged ? 'Unstage all' : 'Stage all'}
          >
            {staged ? 'Unstage all' : 'Stage all'}
          </button>
        )}
      </div>
      {files.map((file) => {
        const key = rowKey(file.path, staged);
        const isOpen = expanded.has(key);
        const diff = diffs.get(key);
        const dir = fileDir(file.path);
        const name = fileName(file.path);
        return (
          <div key={key} className={`git-changes-item ${isOpen ? 'git-changes-item-open' : ''}`}>
            <div className="git-changes-row" onContextMenu={(e) => onContextMenu(e, file)}>
              <button
                className="git-changes-file-btn"
                onClick={() => onToggle(file.path, staged)}
                title={file.path}
              >
                <span className={`git-changes-arrow ${isOpen ? 'git-changes-arrow-open' : ''}`}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 3 11 8 6 13" />
                  </svg>
                </span>
                <FileIcon filename={name} isDirectory={false} />
                <span className="git-changes-filename">{name}</span>
                <span className="git-changes-filedir">{dir}</span>
                <span className="git-changes-meta">
                  <span className="git-changes-counts">
                    {file.added > 0 && <span className="git-changes-added">+{file.added}</span>}
                    {file.deleted > 0 && <span className="git-changes-deleted">−{file.deleted}</span>}
                  </span>
                  <span className="git-changes-status" data-status={file.status}>
                    {file.status === 'untracked' ? 'U' : file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}
                  </span>
                </span>
              </button>
              <button
                className="git-changes-stage-btn"
                onClick={(e) => { e.stopPropagation(); onMove(file.path); }}
                title={staged ? 'Unstage (move up)' : 'Stage (move down)'}
              >
                {/* Down arrow = stage (top → bottom). Up arrow = unstage. */}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  {staged ? (
                    <>
                      <line x1="8" y1="13" x2="8" y2="3" />
                      <polyline points="4 7 8 3 12 7" />
                    </>
                  ) : (
                    <>
                      <line x1="8" y1="3" x2="8" y2="13" />
                      <polyline points="4 9 8 13 12 9" />
                    </>
                  )}
                </svg>
              </button>
            </div>
            {isOpen && (
              <div className="git-changes-diff-wrapper">
                {diff === undefined ? (
                  <div className="git-diff-empty">Loading diff...</div>
                ) : (
                  <FileDiff diff={diff} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
