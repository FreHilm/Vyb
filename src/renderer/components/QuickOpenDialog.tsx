import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon } from '../file-icons';
import { workspaceSymbolPattern } from '../lib/monaco-definitions';

// ── Quick-open file picker (T-043) ─────────────────────────────────
//
// Cmd+P-style fuzzy file finder. Lists every file under the active
// profile's working directory (gitignore-aware via `git ls-files`)
// and lets the user filter by fuzzy match, then opens the chosen
// file in the editor.
//
// The list is fetched once when the dialog mounts; for very large
// repos the IPC caps at 10k entries. Match scoring is intentionally
// simple: subsequence with a small bonus for matches at word
// boundaries / path-segment starts. Sub-millisecond on lists of
// that size; no point reaching for a fuzzy library.

export interface QuickOpenDialogProps {
  workingDirectory: string;
  /** Called with the chosen relative path (and, for symbol-mode picks,
   * the 1-based line). Caller is responsible for resolving against
   * workingDirectory and opening the file. */
  onPick: (relativePath: string, line?: number) => void;
  onClose: () => void;
}

/** One row in '#symbol' mode — a definition found by ripgrep. */
interface SymbolRow {
  path: string;
  line: number;
  /** The matched source line, trimmed for display. */
  text: string;
}

interface ScoredEntry {
  path: string;
  /** Higher is better. -1 means filtered out. */
  score: number;
  /** Indices of matched characters for highlight rendering. */
  matches: number[];
}

function scorePath(needle: string, hay: string): { score: number; matches: number[] } {
  if (!needle) return { score: 0, matches: [] };
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  // Subsequence match. For each needle char, find it in hay after
  // the previous match. Track total score + match positions.
  let score = 0;
  let hi = 0;
  const matches: number[] = [];
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === ch) { found = hi; break; }
      hi++;
    }
    if (found === -1) return { score: -1, matches: [] };
    matches.push(found);
    // Bonus for matches at word boundaries (after / or _ or -) or
    // at path-segment starts.
    const prev = found === 0 ? '/' : h[found - 1];
    if (prev === '/') score += 8;
    else if (prev === '_' || prev === '-' || prev === '.') score += 4;
    else score += 1;
    hi = found + 1;
  }
  // Tighter matches (fewer characters between start and end of
  // match span) score higher.
  const span = matches[matches.length - 1] - matches[0] + 1;
  score -= Math.max(0, span - n.length);
  // Boost matches in the file's basename over deep path matches.
  const lastSlash = hay.lastIndexOf('/');
  if (lastSlash >= 0 && matches[0] > lastSlash) score += 12;
  return { score, matches };
}

export function QuickOpenDialog({ workingDirectory, onPick, onClose }: QuickOpenDialogProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.listProjectFiles(workingDirectory).then((result) => {
      if (!cancelled) setFiles(result);
    });
    return () => { cancelled = true; };
  }, [workingDirectory]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // '#name' → workspace symbol search (VS Code's ⌘T, reached via the
  // same ⌘P box). ripgrep-backed with the shared definition-keyword
  // pattern; results are definition lines across the whole workspace.
  const symbolMode = query.startsWith('#');
  const [symbolRows, setSymbolRows] = useState<SymbolRow[]>([]);
  const [symbolSearching, setSymbolSearching] = useState(false);
  const symbolReqRef = useRef(0);
  useEffect(() => {
    if (!symbolMode) { setSymbolRows([]); setSymbolSearching(false); return; }
    const needle = query.slice(1).trim();
    if (needle.length < 2) { setSymbolRows([]); setSymbolSearching(false); return; }
    setSymbolSearching(true);
    const id = ++symbolReqRef.current;
    const t = setTimeout(() => {
      window.api.searchInFiles(workingDirectory, workspaceSymbolPattern(needle), {
        regex: true,
        caseSensitive: false,
      }).then((r) => {
        if (id !== symbolReqRef.current) return;
        setSymbolRows((r.matches ?? []).slice(0, 50).map((m) => ({
          path: m.path,
          line: m.lineNumber,
          text: m.line.trim().slice(0, 120),
        })));
        setSymbolSearching(false);
      }).catch(() => {
        if (id === symbolReqRef.current) setSymbolSearching(false);
      });
    }, 200);
    return () => clearTimeout(t);
  }, [symbolMode, query, workingDirectory]);

  const matches = useMemo<ScoredEntry[]>(() => {
    if (!query.trim()) {
      // Empty query: show first ~50 files alphabetically (or by
      // ls-files order, which is roughly tracked-then-untracked).
      return files.slice(0, 50).map((p): ScoredEntry => ({ path: p, score: 0, matches: [] }));
    }
    const result: ScoredEntry[] = [];
    for (const f of files) {
      const { score, matches: m } = scorePath(query.trim(), f);
      if (score >= 0) result.push({ path: f, score, matches: m });
    }
    result.sort((a, b) => b.score - a.score);
    return result.slice(0, 50);
  }, [files, query]);

  const activeCount = symbolMode ? symbolRows.length : matches.length;

  // Clamp selected index when results shrink.
  useEffect(() => {
    if (selectedIdx >= activeCount) setSelectedIdx(Math.max(0, activeCount - 1));
  }, [activeCount, selectedIdx]);

  // Scroll selected row into view on arrow nav.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.children[selectedIdx] as HTMLElement | undefined;
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(activeCount - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (symbolMode) {
        const row = symbolRows[selectedIdx];
        if (row) onPick(row.path, row.line);
      } else {
        const chosen = matches[selectedIdx];
        if (chosen) onPick(chosen.path);
      }
      return;
    }
  }, [matches, symbolMode, symbolRows, activeCount, selectedIdx, onPick, onClose]);

  const renderMatchedPath = (entry: ScoredEntry) => {
    if (entry.matches.length === 0) return entry.path;
    // Walk both the matches array and the path; bold matched chars.
    const out: React.ReactNode[] = [];
    let mi = 0;
    for (let i = 0; i < entry.path.length; i++) {
      if (mi < entry.matches.length && entry.matches[mi] === i) {
        out.push(<strong key={i} className="quick-open-match">{entry.path[i]}</strong>);
        mi++;
      } else {
        out.push(entry.path[i]);
      }
    }
    return out;
  };

  return (
    <div className="quick-open-overlay" onMouseDown={onClose}>
      <div className="quick-open-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          type="text"
          className="quick-open-input"
          placeholder={files.length === 0 ? 'Loading…' : `Search ${files.length} file${files.length === 1 ? '' : 's'}…`}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0); }}
          spellCheck={false}
        />
        <div className="quick-open-list" ref={listRef}>
          {symbolMode ? (
            <>
              {symbolRows.length === 0 && (
                <div className="quick-open-empty">
                  {query.slice(1).trim().length < 2 ? 'Type a symbol name…'
                    : symbolSearching ? 'Searching symbols…'
                      : 'No symbols found.'}
                </div>
              )}
              {symbolRows.map((row, idx) => {
                const name = row.path.split('/').pop() || row.path;
                return (
                  <button
                    key={`${row.path}:${row.line}:${idx}`}
                    className={`quick-open-row${idx === selectedIdx ? ' is-active' : ''}`}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => onPick(row.path, row.line)}
                    title={`${row.path}:${row.line}`}
                  >
                    <FileIcon filename={name} isDirectory={false} />
                    <span className="quick-open-path">
                      <code className="quick-open-symbol-text">{row.text}</code>
                      <span className="quick-open-symbol-loc"> — {row.path}:{row.line}</span>
                    </span>
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {matches.length === 0 && (
                <div className="quick-open-empty">
                  {files.length === 0 ? 'Scanning files…' : 'No matches.'}
                </div>
              )}
              {matches.map((entry, idx) => {
                const name = entry.path.split('/').pop() || entry.path;
                return (
                  <button
                    key={entry.path}
                    className={`quick-open-row${idx === selectedIdx ? ' is-active' : ''}`}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => onPick(entry.path)}
                    title={entry.path}
                  >
                    <FileIcon filename={name} isDirectory={false} />
                    <span className="quick-open-path">{renderMatchedPath(entry)}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="quick-open-footer">
          <span>↑↓ navigate · ↵ open · # symbols · esc cancel</span>
        </div>
      </div>
    </div>
  );
}
