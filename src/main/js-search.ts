import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { FileSearchOptions, FileSearchResult, FileSearchMatch } from '../shared/types';

// ── Pure-JS cross-file search fallback ────────────────────────────────
//
// Backup engine for Find in Files when the bundled ripgrep binary can't
// be resolved or fails to start. Everything runs in-process — no external
// binaries — so search always works, just slower on very large repos.
// Semantics mirror the ripgrep invocation in ipc-handlers: case toggle,
// whole-word, regex/literal, include/exclude globs, first match per line,
// 500-match cap, 2 MB per-file ceiling.

const CAP = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 50_000;
const TIME_BUDGET_MS = 15_000;

/** Minimal glob → RegExp: `**` any path, `*` within a segment, `?` one
 * char. Globs without a slash match the basename (rg's -g behavior). */
function globToRegex(glob: string): { re: RegExp; basenameOnly: boolean } {
  const basenameOnly = !glob.includes('/');
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` swallows the slash too
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return { re: new RegExp(`^${out}$`), basenameOnly };
}

function parseGlobs(raw: string | undefined): { re: RegExp; basenameOnly: boolean }[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegex);
}

function matchesGlobs(relPath: string, globs: { re: RegExp; basenameOnly: boolean }[]): boolean {
  const base = path.basename(relPath);
  return globs.some((g) => g.re.test(g.basenameOnly ? base : relPath));
}

/** All candidate files, repo-relative with forward slashes. Prefers
 * `git ls-files` (fast, .gitignore-aware, includes untracked); falls back
 * to a bounded recursive walk for non-git directories. */
function listFiles(cwd: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );
    const files = out.split('\0').filter(Boolean);
    if (files.length > 0) return files.slice(0, MAX_FILES);
  } catch { /* not a git repo / git missing — walk instead */ }

  const acc: string[] = [];
  const SKIP = new Set(['.git', 'node_modules', '.vite', 'dist', 'out']);
  const walk = (dir: string, rel: string) => {
    if (acc.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (acc.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        acc.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(cwd, '');
  return acc;
}

export function searchInFilesJs(cwd: string, query: string, opts?: FileSearchOptions): FileSearchResult {
  const empty: FileSearchResult = { matches: [], truncated: false, fallbackUsed: false };
  if (!cwd || !query) return empty;

  let source = query;
  if (!opts?.regex) source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts?.wholeWord) source = `\\b(?:${source})\\b`;
  let re: RegExp;
  try {
    re = new RegExp(source, opts?.caseSensitive ? '' : 'i');
  } catch (err) {
    return { ...empty, error: `Invalid pattern: ${(err as Error).message}` };
  }

  let include: { re: RegExp; basenameOnly: boolean }[];
  let exclude: { re: RegExp; basenameOnly: boolean }[];
  try {
    include = parseGlobs(opts?.include);
    exclude = parseGlobs(opts?.exclude);
  } catch {
    return { ...empty, error: 'invalid include/exclude glob' };
  }

  const started = Date.now();
  const matches: FileSearchMatch[] = [];
  let truncated = false;

  for (const rel of listFiles(cwd)) {
    if (matches.length >= CAP) { truncated = true; break; }
    if (Date.now() - started > TIME_BUDGET_MS) { truncated = true; break; }
    if (include.length > 0 && !matchesGlobs(rel, include)) continue;
    if (exclude.length > 0 && matchesGlobs(rel, exclude)) continue;

    const abs = path.join(cwd, rel);
    let buf: Buffer;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch { continue; }
    // Binary sniff: a NUL byte in the head means "not text" — skip.
    if (buf.subarray(0, 8192).includes(0)) continue;

    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const m = re.exec(line);
      if (!m) continue;
      matches.push({
        path: rel,
        lineNumber: i + 1,
        line: line.length > 500 ? line.slice(0, 500) + '…' : line,
        matchStart: m.index,
        matchEnd: m.index + m[0].length,
      });
      if (matches.length >= CAP) { truncated = true; break; }
    }
  }

  return { matches, truncated, fallbackUsed: false };
}
