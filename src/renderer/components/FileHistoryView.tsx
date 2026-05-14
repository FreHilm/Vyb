import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GitCommit } from '../../shared/types';
import { FileDiff } from './GitChangesPanel';

// ── File history overlay (T-026) ───────────────────────────────────
//
// Opened from the File Explorer's right-click menu → "Show history".
// Lists every commit that touched the file (using `git log --follow`
// so renames are chased) on the left, and renders the per-commit diff
// of that file on the right via the shared FileDiff component.
//
// We deliberately don't virtualise the commit list in V1 — the IPC
// caps at 5000 commits which is fine for ad-hoc DOM rendering on the
// kind of files anyone is actually browsing. Add windowing in V2 if
// real-world repos hit the cap regularly.

export interface FileHistoryViewProps {
  workingDirectory: string;
  filePath: string;
  fileName: string;
  onClose: () => void;
  /** Optional SHA to preselect once the commit list loads. Set when
   * the overlay is opened by clicking a T-027 blame gutter marker so
   * the diff jumps straight to the relevant commit. */
  initialSha?: string | null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function FileHistoryView({ workingDirectory, filePath, fileName, onClose, initialSha }: FileHistoryViewProps) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [loadingCommits, setLoadingCommits] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [query, setQuery] = useState('');
  const [viewMode] = useState<'unified' | 'split'>('unified');

  useEffect(() => {
    let cancelled = false;
    setLoadingCommits(true);
    setSelectedSha(null);
    setDiff('');
    (async () => {
      const result = await window.api.gitFileLog(workingDirectory, filePath);
      if (cancelled) return;
      setCommits(result);
      // Preselect the requested SHA when present (T-027 blame click);
      // otherwise default to newest-first.
      const wanted = initialSha && result.find((c) => c.sha === initialSha || c.sha.startsWith(initialSha))?.sha;
      setSelectedSha(wanted || (result.length > 0 ? result[0].sha : null));
      setLoadingCommits(false);
    })();
    return () => { cancelled = true; };
  }, [workingDirectory, filePath, initialSha]);

  useEffect(() => {
    if (!selectedSha) {
      setDiff('');
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    (async () => {
      const text = await window.api.gitFileLogDiff(workingDirectory, selectedSha, filePath);
      if (cancelled) return;
      setDiff(text);
      setLoadingDiff(false);
    })();
    return () => { cancelled = true; };
  }, [selectedSha, workingDirectory, filePath]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter((c) =>
      c.subject.toLowerCase().includes(q)
      || c.author.toLowerCase().includes(q)
      || c.sha.startsWith(q),
    );
  }, [commits, query]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (filtered.length === 0 || !selectedSha) return;
    const idx = filtered.findIndex((c) => c.sha === selectedSha);
    if (idx < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      const next = filtered[Math.min(idx + 1, filtered.length - 1)];
      if (next) setSelectedSha(next.sha);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      const prev = filtered[Math.max(idx - 1, 0)];
      if (prev) setSelectedSha(prev.sha);
    }
  }, [filtered, selectedSha, onClose]);

  return (
    <div className="file-history-overlay" role="dialog" aria-label={`History of ${fileName}`} tabIndex={-1} onKeyDown={onKey}>
      <div className="file-history-header">
        <div className="file-history-title">
          <span className="file-history-title-label">History</span>
          <code className="file-history-title-path" title={filePath}>{fileName}</code>
          {commits.length > 0 && (
            <span className="file-history-count">{commits.length} commit{commits.length === 1 ? '' : 's'}</span>
          )}
        </div>
        <button className="file-history-close" onClick={onClose} aria-label="Close history" title="Close (Esc)">×</button>
      </div>
      <div className="file-history-body">
        <div className="file-history-list">
          <input
            className="file-history-search"
            type="text"
            placeholder="Filter by subject / author / SHA…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loadingCommits ? (
            <div className="file-history-loading">Loading history…</div>
          ) : filtered.length === 0 ? (
            <div className="file-history-empty">
              {commits.length === 0 ? 'No commits found for this file.' : 'No matches.'}
            </div>
          ) : (
            <div className="file-history-commits">
              {filtered.map((c) => (
                <button
                  key={c.sha}
                  className={`file-history-commit${selectedSha === c.sha ? ' file-history-commit-active' : ''}`}
                  onClick={() => setSelectedSha(c.sha)}
                >
                  <div className="file-history-commit-subject">{c.subject}</div>
                  <div className="file-history-commit-meta">
                    <code className="file-history-commit-sha">{shortSha(c.sha)}</code>
                    <span className="file-history-commit-author">{c.author}</span>
                    <span className="file-history-commit-date">{relativeDate(c.date)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="file-history-diff-pane">
          {loadingDiff ? (
            <div className="file-history-loading">Loading diff…</div>
          ) : !selectedSha ? (
            <div className="file-history-empty">Select a commit to see its changes.</div>
          ) : !diff ? (
            <div className="file-history-empty">No changes to this file in the selected commit.</div>
          ) : (
            <FileDiff diff={diff} mode={viewMode} />
          )}
        </div>
      </div>
    </div>
  );
}
