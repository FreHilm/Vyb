import { useEffect, useState, useCallback, useRef } from 'react';
import { FileIcon } from '../file-icons';
import { GitTree } from './GitTree';
import { BranchTree } from './BranchTree';

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
interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'file';
  oldLine: number | null;
  newLine: number | null;
  content: string;
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
            <code className="git-diff-content">{line.content}</code>
          </div>
        );
      })}
    </div>
  );
}

export function GitChangesPanel({ workingDirectory, onClose, widthPercent, onWidthChange, activeTab, onTabChange }: GitChangesPanelProps) {
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [commitSubject, setCommitSubject] = useState('');
  const [commitDescription, setCommitDescription] = useState('');
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ChangesCtxMenuState | null>(null);
  const [discardTarget, setDiscardTarget] = useState<GitChangedFile | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.api.getGitChangedFiles(workingDirectory);
    setFiles(result);
    setLoading(false);
  }, [workingDirectory]);

  useEffect(() => {
    load();
  }, [load]);

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

  const handleCommit = useCallback(async () => {
    if (!commitSubject.trim() || commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      const result = await window.api.gitCommit(workingDirectory, commitSubject, commitDescription);
      if (!result.ok) {
        setCommitError(result.message ?? 'commit failed');
      } else {
        setCommitSubject('');
        setCommitDescription('');
        // Optimistic: drop staged files locally; reload reconciles.
        setFiles((prev) => prev.filter((f) => !f.staged));
        await reloadFiles();
      }
    } finally {
      setCommitBusy(false);
    }
  }, [workingDirectory, commitSubject, commitDescription, commitBusy, reloadFiles]);

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
          {activeTab === 'changes' && (
            <button className="git-changes-btn" onClick={load} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
                <polyline points="13 3 13 6 10 6" />
                <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
                <polyline points="3 13 3 10 6 10" />
              </svg>
            </button>
          )}
          <button className="git-changes-btn" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      </div>
      {activeTab === 'tree' ? (
        <div className="git-changes-body">
          <GitTree workingDirectory={workingDirectory} />
        </div>
      ) : activeTab === 'branches' ? (
        <div className="git-changes-body">
          <BranchTree workingDirectory={workingDirectory} />
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
        />
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
}: ChangesViewProps) {
  const unstaged = files.filter((f) => !f.staged);
  const staged = files.filter((f) => f.staged);
  const canCommit = staged.length > 0 && commitSubject.trim().length > 0 && !commitBusy;

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
        <button
          className="git-commit-btn"
          disabled={!canCommit}
          onClick={onCommit}
          title={
            staged.length === 0
              ? 'Stage a file first'
              : !commitSubject.trim()
                ? 'Enter a subject'
                : 'Commit (⌘↵)'
          }
        >
          {commitBusy ? 'Committing…' : `Commit ${staged.length} ${staged.length === 1 ? 'file' : 'files'}`}
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
