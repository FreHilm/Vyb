import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileSearchMatch, FileSearchResult } from '../../shared/types';
import { FileIcon } from '../file-icons';

// ── Find in Files panel (T-044) ────────────────────────────────────
//
// Cross-file ripgrep-backed search. Opens as an overlay over the
// Files tab. The IPC behind it caps at 500 matches and 30s timeout;
// for V1 we batch-fetch rather than stream, because ripgrep returns
// in well under a second on typical repos and the UX cost of "wait
// briefly, get a full result" is small compared to the code cost of
// a streaming protocol.
//
// New queries cancel the in-flight one via a `requestId` ref —
// stale responses just no-op when their id doesn't match.

export interface FindInFilesPanelProps {
  workingDirectory: string;
  onClose: () => void;
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

export function FindInFilesPanel({ workingDirectory, onClose, onOpenResult }: FindInFilesPanelProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
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
      }).catch(() => {
        if (id !== requestIdRef.current) return;
        setSearching(false);
        setResult({ matches: [], truncated: false, fallbackUsed: false, error: 'search failed' });
      });
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, caseSensitive, wholeWord, regex, include, exclude, workingDirectory]);

  const grouped = useMemo(() => result ? groupByFile(result.matches) : [], [result]);
  const totalMatches = result?.matches.length ?? 0;

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleClickResult = useCallback((m: FileSearchMatch) => {
    const base = workingDirectory.replace(/\/+$/, '');
    const absolute = `${base}/${m.path}`;
    onOpenResult(absolute, m.lineNumber);
  }, [workingDirectory, onOpenResult]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  return (
    <div className="find-in-files-panel" onKeyDown={onKey}>
      <div className="find-in-files-header">
        <span className="find-in-files-title">Find in Files</span>
        <button className="find-in-files-close" onClick={onClose} title="Close (Esc)">×</button>
      </div>
      <div className="find-in-files-form">
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
        {!searching && result && !result.error && (
          <>
            {totalMatches === 0 && query.trim()
              ? 'No results.'
              : `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${grouped.length} file${grouped.length === 1 ? '' : 's'}`}
            {result.truncated && <span className="find-in-files-truncated"> · capped at 500</span>}
          </>
        )}
        {!searching && result?.fallbackUsed && (
          <span className="find-in-files-warn">ripgrep not installed — install it for cross-file search.</span>
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
          return (
            <div key={g.path} className="find-in-files-group">
              <button
                className="find-in-files-file-row"
                onClick={() => toggleCollapsed(g.path)}
                title={g.path}
              >
                <span className={`file-tree-arrow ${isCollapsed ? '' : 'is-open'}`} style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 3 11 8 6 13" />
                  </svg>
                </span>
                <FileIcon filename={fileName} isDirectory={false} />
                <span className="find-in-files-filename">{fileName}</span>
                {dir && <span className="find-in-files-dir">{dir}</span>}
                <span className="find-in-files-count">{g.matches.length}</span>
              </button>
              {!isCollapsed && g.matches.map((m, idx) => (
                <button
                  key={`${m.path}:${m.lineNumber}:${idx}`}
                  className="find-in-files-line-row"
                  onClick={() => handleClickResult(m)}
                  title={`${m.path}:${m.lineNumber}`}
                >
                  <span className="find-in-files-lineno">{m.lineNumber}</span>
                  <code className="find-in-files-line">{highlightMatch(m.line, m.matchStart, m.matchEnd)}</code>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
