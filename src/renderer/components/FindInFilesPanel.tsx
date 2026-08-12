import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileReplaceTarget, FileSearchMatch, FileSearchResult } from '../../shared/types';
import { FileIcon } from '../file-icons';

// ── Search panel: Find & Replace in Files (T-044 + replace) ───────
//
// Cross-file ripgrep-backed search with VS Code-style replace, docked
// on the right edge like the Git panel (the two are mutually exclusive
// — App closes one when the other opens). Replace granularity mirrors
// VS Code: Replace All (two-step confirm), per-file, and per-match,
// plus dismiss buttons to drop entries from the list without touching
// the file.
//
// Replace safety:
//  • Files with unsaved editor changes (dirtyPaths) are never written —
//    they're skipped and reported, so typed-but-unsaved work survives.
//  • The main process re-matches each file at replace time and only
//    replaces occurrences that still exist at the recorded line+column;
//    anything that moved is skipped and reported (never mis-replaced).
//  • Targets are always the explicitly listed matches, so dismissed
//    entries are honored and a truncated (capped) result never silently
//    replaces beyond what's shown.
//
// New queries cancel the in-flight one via a `requestId` ref — stale
// responses just no-op when their id doesn't match.

export interface FindInFilesPanelProps {
  workingDirectory: string;
  /** Width as a percentage of the parent pane (resizable, like git). */
  widthPercent: number;
  onWidthChange: (next: number) => void;
  onClose: () => void;
  /** Set when the Edit menu opens the panel — focuses the query input
   * and, for "Replace in Files…", expands the replace row. */
  openRequest?: { withReplace: boolean; nonce: number; query?: string; wholeWord?: boolean } | null;
  /** Absolute paths of files with unsaved editor changes — excluded
   * from replace and reported as skipped. */
  dirtyPaths: string[];
  /** Called with an absolute path + 1-based line number when the
   * user clicks a result. Caller is responsible for ensuring the
   * Files tab is mounted and opening the file. */
  onOpenResult: (absolutePath: string, line: number) => void;
}

interface GroupedMatch {
  path: string;
  matches: FileSearchMatch[];
}

function groupByFile(matches: FileSearchMatch[]): GroupedMatch[] {
  const map = new Map<string, FileSearchMatch[]>();
  for (const m of matches) {
    const list = map.get(m.path) ?? [];
    list.push(m);
    map.set(m.path, list);
  }
  return Array.from(map.entries()).map(([path, ms]) => ({ path, matches: ms }));
}

function matchKey(m: FileSearchMatch): string {
  return `${m.path}:${m.lineNumber}:${m.matchStart}`;
}

function highlightMatch(line: string, start: number, end: number): React.ReactNode {
  if (end <= start || start < 0 || start >= line.length) return line;
  return (
    <>
      {line.slice(0, start)}
      <mark className="find-in-files-match">{line.slice(start, end)}</mark>
      {line.slice(end)}
    </>
  );
}

/** "Substitute" glyph for the replace buttons (a·b with an arrow). */
function ReplaceGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h7a3 3 0 0 1 3 3v1" />
      <path d="M10.5 11.5 13 9l-2.5-2.5" transform="translate(0 2.5)" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function FindInFilesPanel({
  workingDirectory, widthPercent, onWidthChange, onClose, openRequest, dirtyPaths, onOpenResult,
}: FindInFilesPanelProps) {
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [replaceSummary, setReplaceSummary] = useState<string | null>(null);
  const [armedAll, setArmedAll] = useState(false);
  // Bumped after a replace so the search effect re-runs with fresh files.
  const [searchNonce, setSearchNonce] = useState(0);
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Edit-menu open requests: focus the query, expand replace for ⌘⇧H.
  // A request carrying a query (Find All References) pre-fills it as a
  // plain whole-word search — the debounced search effect below runs it.
  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.withReplace) setShowReplace(true);
    if (openRequest.query !== undefined) {
      setQuery(openRequest.query);
      setWholeWord(openRequest.wholeWord === true);
      setRegex(false);
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [openRequest?.nonce, openRequest]);

  // Canned hygiene search: every TODO / FIXME / HACK in the workspace.
  const searchTodos = useCallback(() => {
    setRegex(true);
    setWholeWord(false);
    setCaseSensitive(true);
    setQuery('TODO|FIXME|HACK');
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      const id = ++requestIdRef.current;
      window.api.searchInFiles(workingDirectory, query, {
        caseSensitive, wholeWord, regex, include, exclude,
      }).then((r) => {
        // Stale response; a newer query has already taken over.
        if (id !== requestIdRef.current) return;
        setResult(r);
        setSearching(false);
        setDismissed(new Set());
        setArmedAll(false);
      }).catch(() => {
        if (id !== requestIdRef.current) return;
        setSearching(false);
        setResult({ matches: [], truncated: false, fallbackUsed: false, error: 'search failed' });
      });
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, caseSensitive, wholeWord, regex, include, exclude, workingDirectory, searchNonce]);

  // Clear the one-shot replace summary as soon as the inputs change.
  useEffect(() => {
    setReplaceSummary(null);
    setArmedAll(false);
  }, [query, caseSensitive, wholeWord, regex, include, exclude, replaceText]);

  // Visible (non-dismissed) matches, grouped per file.
  const grouped = useMemo(() => {
    if (!result) return [];
    const visible = result.matches.filter((m) => !dismissed.has(matchKey(m)));
    return groupByFile(visible);
  }, [result, dismissed]);
  const totalMatches = useMemo(() => grouped.reduce((n, g) => n + g.matches.length, 0), [grouped]);

  const base = workingDirectory.replace(/\/+$/, '');
  const dirtySet = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const isDirty = useCallback((relPath: string) => dirtySet.has(`${base}/${relPath}`), [dirtySet, base]);

  // ── Resize (same interaction as the git panel) ────────────────
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthPercent;
    const parentWidth = panelRef.current?.parentElement?.clientWidth || window.innerWidth;
    const onMove = (ev: MouseEvent) => {
      // Left-docked panel: dragging right grows it (the git panel's
      // right-docked math is the mirror image).
      const deltaPct = ((ev.clientX - startX) / parentWidth) * 100;
      onWidthChange(Math.max(20, Math.min(80, startWidth + deltaPct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [widthPercent, onWidthChange]);

  // ── Replace ───────────────────────────────────────────────────
  const runReplace = useCallback(async (groups: GroupedMatch[]) => {
    if (replaceBusy || groups.length === 0) return;
    const targets: FileReplaceTarget[] = [];
    let dirtySkipped = 0;
    for (const g of groups) {
      if (isDirty(g.path)) {
        dirtySkipped++;
        continue;
      }
      targets.push({
        path: g.path,
        matches: g.matches.map((m) => ({ lineNumber: m.lineNumber, matchStart: m.matchStart })),
      });
    }
    let summary: string;
    if (targets.length === 0) {
      summary = dirtySkipped > 0
        ? `Nothing replaced — ${dirtySkipped} file${dirtySkipped === 1 ? ' has' : 's have'} unsaved changes.`
        : 'Nothing to replace.';
      setReplaceSummary(summary);
      return;
    }
    setReplaceBusy(true);
    try {
      const r = await window.api.replaceInFiles(
        workingDirectory, query,
        { caseSensitive, wholeWord, regex, include, exclude },
        replaceText, targets,
      );
      const parts: string[] = [];
      if (r.error) parts.push(r.error);
      else parts.push(`Replaced ${r.replacedMatches} match${r.replacedMatches === 1 ? '' : 'es'} in ${r.replacedFiles} file${r.replacedFiles === 1 ? '' : 's'}.`);
      if (dirtySkipped > 0) parts.push(`${dirtySkipped} file${dirtySkipped === 1 ? '' : 's'} skipped (unsaved changes).`);
      if (r.skipped.length > 0) parts.push(`${r.skipped.length} occurrence${r.skipped.length === 1 ? '' : 's'} skipped (file changed).`);
      summary = parts.join(' ');
    } catch {
      summary = 'Replace failed.';
    }
    setReplaceBusy(false);
    setReplaceSummary(summary);
    setArmedAll(false);
    // Re-run the search so the list reflects the rewritten files.
    setSearchNonce((n) => n + 1);
  }, [replaceBusy, isDirty, workingDirectory, query, caseSensitive, wholeWord, regex, include, exclude, replaceText]);

  const handleReplaceAll = useCallback(() => {
    if (!armedAll) {
      setArmedAll(true);
      return;
    }
    setArmedAll(false);
    void runReplace(grouped);
  }, [armedAll, runReplace, grouped]);

  const handleReplaceFile = useCallback((g: GroupedMatch) => {
    void runReplace([g]);
  }, [runReplace]);

  const handleReplaceMatch = useCallback((g: GroupedMatch, m: FileSearchMatch) => {
    void runReplace([{ path: g.path, matches: [m] }]);
  }, [runReplace]);

  // ── Dismiss (drop from the list without touching the file) ────
  const dismissMatch = useCallback((m: FileSearchMatch) => {
    setDismissed((prev) => new Set(prev).add(matchKey(m)));
  }, []);
  const dismissFile = useCallback((g: GroupedMatch) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const m of g.matches) next.add(matchKey(m));
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleClickResult = useCallback((m: FileSearchMatch) => {
    onOpenResult(`${base}/${m.path}`, m.lineNumber);
  }, [base, onOpenResult]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  const canReplace = !replaceBusy && !searching && totalMatches > 0;

  return (
    <div ref={panelRef} className="find-in-files-panel" style={{ width: `${widthPercent}%` }} onKeyDown={onKey}>
      <div className="git-changes-resize" onMouseDown={handleResizeStart} />
      <div className="find-in-files-header">
        <span className="find-in-files-title">Search</span>
        <button
          className="find-in-files-todos"
          onClick={searchTodos}
          title="List every TODO / FIXME / HACK in the workspace"
        >
          TODOs
        </button>
        <button className="find-in-files-close" onClick={onClose} title="Close (Esc)">×</button>
      </div>
      <div className="find-in-files-form">
        <div className="find-in-files-search-row">
          <button
            className={`find-in-files-replace-toggle${showReplace ? ' is-open' : ''}`}
            onClick={() => setShowReplace((v) => !v)}
            title={showReplace ? 'Hide replace' : 'Show replace'}
            aria-expanded={showReplace}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ transform: showReplace ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s' }}>
              <polyline points="6 3 11 8 6 13" />
            </svg>
          </button>
          <div className="find-in-files-inputs">
            <input
              ref={inputRef}
              type="text"
              className="find-in-files-query"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            <div className="find-in-files-toggles">
              <label title="Match case (Aa)">
                <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
                <span>Aa</span>
              </label>
              <label title="Whole word (\\b)">
                <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
                <span>ab</span>
              </label>
              <label title="Regular expression (.*)">
                <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
                <span>.*</span>
              </label>
            </div>
            {showReplace && (
              <div className="find-in-files-replace-row">
                <input
                  type="text"
                  className="find-in-files-query"
                  placeholder={regex ? 'Replace ($1 for groups)…' : 'Replace…'}
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  spellCheck={false}
                />
                <button
                  className={`find-in-files-replace-all${armedAll ? ' is-armed' : ''}`}
                  disabled={!canReplace}
                  onClick={handleReplaceAll}
                  title="Replace every listed match (skips files with unsaved changes)"
                >
                  {replaceBusy ? 'Replacing…' : armedAll ? `Replace ${totalMatches}?` : 'Replace All'}
                </button>
              </div>
            )}
          </div>
        </div>
        <input
          type="text"
          className="find-in-files-glob"
          placeholder="files to include (e.g. src/**/*.ts)"
          value={include}
          onChange={(e) => setInclude(e.target.value)}
          spellCheck={false}
        />
        <input
          type="text"
          className="find-in-files-glob"
          placeholder="files to exclude (e.g. **/*.test.ts)"
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="find-in-files-status">
        {searching && 'Searching…'}
        {!searching && replaceSummary && <span>{replaceSummary} </span>}
        {!searching && !replaceSummary && result && !result.error && (
          <>
            {totalMatches === 0 && query.trim()
              ? 'No results.'
              : `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${grouped.length} file${grouped.length === 1 ? '' : 's'}`}
            {result.truncated && <span className="find-in-files-truncated"> · capped at 500 — replace applies to listed matches only</span>}
          </>
        )}
        {!searching && result?.fallbackUsed && (
          <span className="find-in-files-warn">Search engine unavailable — try restarting Vyb.</span>
        )}
        {!searching && result?.error && !result.fallbackUsed && (
          <span className="find-in-files-warn">{result.error}</span>
        )}
      </div>
      <div className="find-in-files-results">
        {grouped.map((g) => {
          const fileName = g.path.split('/').pop() || g.path;
          const dir = g.path.substring(0, g.path.length - fileName.length).replace(/\/$/, '');
          const isCollapsed = collapsed.has(g.path);
          const fileDirty = isDirty(g.path);
          return (
            <div key={g.path} className="find-in-files-group">
              <div className="find-in-files-file-row" title={g.path}>
                <button className="find-in-files-file-main" onClick={() => toggleCollapsed(g.path)}>
                  <span className="file-tree-arrow" style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 3 11 8 6 13" />
                    </svg>
                  </span>
                  <FileIcon filename={fileName} isDirectory={false} />
                  <span className="find-in-files-filename">{fileName}</span>
                  {dir && <span className="find-in-files-dir">{dir}</span>}
                  {fileDirty && <span className="find-in-files-dirty" title="Unsaved editor changes — replace will skip this file">●</span>}
                </button>
                <span className="find-in-files-row-actions">
                  {showReplace && (
                    <button
                      className="find-in-files-action"
                      disabled={!canReplace || fileDirty}
                      onClick={() => handleReplaceFile(g)}
                      title={fileDirty ? 'Skipped — unsaved editor changes' : `Replace all in ${fileName}`}
                    >
                      <ReplaceGlyph />
                    </button>
                  )}
                  <button className="find-in-files-action" onClick={() => dismissFile(g)} title="Dismiss file from results">×</button>
                </span>
                <span className="find-in-files-count">{g.matches.length}</span>
              </div>
              {!isCollapsed && g.matches.map((m, idx) => (
                <div key={`${m.path}:${m.lineNumber}:${m.matchStart}:${idx}`} className="find-in-files-line-row" title={`${m.path}:${m.lineNumber}`}>
                  <button className="find-in-files-line-main" onClick={() => handleClickResult(m)}>
                    <span className="find-in-files-lineno">{m.lineNumber}</span>
                    <code className="find-in-files-line">{highlightMatch(m.line, m.matchStart, m.matchEnd)}</code>
                  </button>
                  <span className="find-in-files-row-actions">
                    {showReplace && (
                      <button
                        className="find-in-files-action"
                        disabled={!canReplace || fileDirty}
                        onClick={() => handleReplaceMatch(g, m)}
                        title={fileDirty ? 'Skipped — unsaved editor changes' : 'Replace this match'}
                      >
                        <ReplaceGlyph />
                      </button>
                    )}
                    <button className="find-in-files-action" onClick={() => dismissMatch(m)} title="Dismiss match">×</button>
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
