import { useEffect, useState, useCallback, useRef } from 'react';
import { FileIcon } from '../file-icons';

interface GitChangedFile {
  path: string;
  added: number;
  deleted: number;
  status: string;
  staged: boolean;
}

interface GitChangesPanelProps {
  workingDirectory: string;
  onClose: () => void;
  widthPercent: number;
  onWidthChange: (pct: number) => void;
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

export function GitChangesPanel({ workingDirectory, onClose, widthPercent, onWidthChange }: GitChangesPanelProps) {
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
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

  const toggleFile = useCallback(async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }
    // Load diff if not already loaded
    if (!diffs.has(path)) {
      const diff = await window.api.getGitFileDiff(workingDirectory, path);
      setDiffs((prev) => new Map(prev).set(path, diff));
    }
    setExpanded((prev) => new Set(prev).add(path));
  }, [expanded, diffs, workingDirectory]);

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
      <div className="git-changes-header">
        <span className="git-changes-title">
          Changes {!loading && `(${files.length})`}
        </span>
        <div className="git-changes-actions">
          <button className="git-changes-btn" onClick={load} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
              <polyline points="13 3 13 6 10 6" />
              <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
              <polyline points="3 13 3 10 6 10" />
            </svg>
          </button>
          <button className="git-changes-btn" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="git-changes-body">
        {loading && <div className="git-changes-loading">Loading...</div>}
        {!loading && files.length === 0 && (
          <div className="git-changes-empty">No changes</div>
        )}
        {!loading && files.map((file) => {
          const isOpen = expanded.has(file.path);
          const diff = diffs.get(file.path);
          const dir = fileDir(file.path);
          const name = fileName(file.path);
          return (
            <div key={file.path} className={`git-changes-item ${isOpen ? 'git-changes-item-open' : ''}`}>
              <button
                className="git-changes-file-btn"
                onClick={() => toggleFile(file.path)}
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
    </div>
  );
}
