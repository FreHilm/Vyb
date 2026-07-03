import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import type { AgentSessionInfo, SessionCaps } from '../shared/types';

// ── Agent session enumeration + resume (cross-agent) ──────────────────
//
// Browses the past sessions an agent CLI has for a project so the user can
// resume one. Only the four built-in agents are supported; custom agents
// have no session handling (the renderer gates on the built-in id).
//
// Two enumeration strategies:
//   • file readers (Claude, Codex) — parse the agent's on-disk store. Fast,
//     no subprocess, works regardless of PATH.
//   • CLI delegators (Gemini, OpenCode) — shell out to the agent's own
//     project-scoped list command with a JSON format flag, then parse.
//
// Resume mechanics differ per agent (see resumeArgs). Worktree-resume is
// only reliable where the agent's session lookup spans the repo + its
// worktrees (Claude) or its store is global/path-independent (Codex), and
// Gemini documents worktree support. OpenCode keys sessions to the original
// path, so worktree-resume is disabled for it (new session only).

/** Per-agent capability matrix, keyed by the resolved command. */
const CAPS: Record<string, SessionCaps> = {
  // OpenCode keys sessions to the directory they were created in, so
  // resuming one from a different-path worktree can't restore it — worktree
  // sessions there are new-session-only (per the user's call). Claude spans
  // the repo + its worktrees. Codex/Gemini resume by id; whether that
  // restores across a worktree's differing cwd is still being validated.
  claude: { canList: true, canResumeInPlace: true, canResumeInWorktree: true },
  codex: { canList: true, canResumeInPlace: true, canResumeInWorktree: true },
  gemini: { canList: true, canResumeInPlace: true, canResumeInWorktree: true },
  opencode: { canList: true, canResumeInPlace: true, canResumeInWorktree: false },
};

export function sessionCaps(command: string): SessionCaps | null {
  return CAPS[command] ?? null;
}

export async function listSessions(command: string, cwd: string): Promise<AgentSessionInfo[]> {
  let dir = cwd;
  if (dir.startsWith('~')) dir = dir.replace(/^~/, os.homedir());
  try {
    switch (command) {
      case 'claude': return listClaude(dir);
      case 'codex': return listCodex(dir);
      case 'gemini': return await listGemini(dir);
      case 'opencode': return await listOpenCode(dir);
      default: return [];
    }
  } catch {
    return [];
  }
}

// ── Claude ────────────────────────────────────────────────────────────
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, one file/session.
// Encoding matches agent-args-guard: non-alphanumerics → '-', lowercased.

function listClaude(cwd: string): AgentSessionInfo[] {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let dirName: string | undefined;
  try {
    dirName = fs.readdirSync(projectsDir, { withFileTypes: true })
      .find((e) => e.isDirectory() && e.name.toLowerCase() === encoded)?.name;
  } catch { return []; }
  if (!dirName) return [];
  const dir = path.join(projectsDir, dirName);
  const out: AgentSessionInfo[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    const id = f.replace(/\.jsonl$/, '');
    let lastActive = 0;
    try { lastActive = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
    out.push({ id, title: firstUserText(full) || id, lastActive });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

/** First human message in a Claude/Codex JSONL transcript (for a title).
 * Reads only the head of the file so big transcripts stay cheap. */
function firstUserText(file: string): string {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf-8', 0, n);
  } catch { return ''; }
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const msg = rec?.message ?? rec;
      if ((rec?.type === 'user' || msg?.role === 'user')) {
        const text = extractText(msg?.content);
        if (text) return clip(text);
      }
    } catch { /* partial trailing line — ignore */ }
  }
  return '';
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text');
    if (t) return String((t as { text?: string }).text ?? '');
  }
  return '';
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 80) + '…' : one;
}

// ── Codex ───────────────────────────────────────────────────────────
// Sessions are global, stored by date: ~/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<uuid>.jsonl. Each rollout's first line is `session_meta`
// with {id, cwd, timestamp}. Titles come from ~/.codex/session_index.jsonl
// ({id, thread_name, updated_at}). We filter to the project by cwd.

function listCodex(cwd: string): AgentSessionInfo[] {
  const base = path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(base, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const names = new Map<string, string>();
  try {
    const idx = fs.readFileSync(path.join(base, 'session_index.jsonl'), 'utf-8');
    for (const line of idx.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.id) names.set(r.id, r.thread_name || ''); } catch { /* ignore */ }
    }
  } catch { /* index optional */ }

  // Collect rollout files, newest first (ISO timestamp in the name sorts
  // chronologically), capped so a huge history doesn't stall the picker.
  const files = walkFiles(sessionsDir, 'rollout-', '.jsonl').sort().reverse().slice(0, 400);
  const target = path.resolve(cwd);
  const out: AgentSessionInfo[] = [];
  for (const full of files) {
    const meta = readCodexMeta(full);
    if (!meta || path.resolve(meta.cwd) !== target) continue;
    out.push({ id: meta.id, title: names.get(meta.id) || meta.firstText || meta.id, lastActive: meta.ts });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

function readCodexMeta(file: string): { id: string; cwd: string; ts: number; firstText: string } | null {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    // Codex's session_meta first line is large (~22 KB — it embeds the
    // initial instructions), so read generously to capture the whole line.
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf-8', 0, n);
  } catch { return null; }
  const firstLine = head.split('\n', 1)[0];
  try {
    const rec = JSON.parse(firstLine);
    if (rec?.type !== 'session_meta') return null;
    const p = rec.payload ?? {};
    if (!p.id || !p.cwd) return null;
    return { id: p.id, cwd: p.cwd, ts: Date.parse(p.timestamp || rec.timestamp || '') || 0, firstText: '' };
  } catch { return null; }
}

// ── Gemini (CLI) ──────────────────────────────────────────────────────
// `gemini --list-sessions` is project-scoped; ask for JSON. Shape isn't
// rigidly documented, so parse defensively across likely field names.

async function listGemini(cwd: string): Promise<AgentSessionInfo[]> {
  const out = await runAgentCli('gemini', ['--list-sessions', '--output-format', 'json'], cwd);
  return parseCliSessions(out);
}

// ── OpenCode (CLI) ────────────────────────────────────────────────────
async function listOpenCode(cwd: string): Promise<AgentSessionInfo[]> {
  const out = await runAgentCli('opencode', ['session', 'list', '--format', 'json'], cwd);
  return parseCliSessions(out);
}

/** Defensive JSON parse for the Gemini/OpenCode list commands — both emit
 * JSON, but field names aren't guaranteed, so probe common ones. Returns []
 * for text/empty output (graceful "no sessions" rather than an error). */
function parseCliSessions(raw: string): AgentSessionInfo[] {
  const json = raw.trim();
  if (!json || (json[0] !== '[' && json[0] !== '{')) return [];
  let data: unknown;
  try { data = JSON.parse(json); } catch { return []; }
  const arr: Record<string, unknown>[] = Array.isArray(data)
    ? data as Record<string, unknown>[]
    : (((data as Record<string, unknown>)?.sessions as Record<string, unknown>[]) ?? []);
  const pick = (o: Record<string, unknown>, keys: string[]): string => {
    for (const k of keys) { const v = o[k]; if (typeof v === 'string' && v) return v; if (typeof v === 'number') return String(v); }
    return '';
  };
  const out: AgentSessionInfo[] = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const id = pick(s, ['sessionId', 'id', 'sessionID', 'session_id']);
    if (!id) continue;
    const title = pick(s, ['title', 'summary', 'name', 'tag', 'description']) || id;
    const stamp = pick(s, ['lastUpdated', 'updatedAt', 'updated', 'startTime', 'created', 'time']);
    out.push({ id, title: clip(title), lastActive: stamp ? (Date.parse(stamp) || Number(stamp) || 0) : 0 });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

// ── helpers ─────────────────────────────────────────────────────────

/** Recursively collect files under `dir` matching prefix/suffix. */
function walkFiles(dir: string, prefix: string, suffix: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, prefix, suffix, acc);
    else if (e.name.startsWith(prefix) && e.name.endsWith(suffix)) acc.push(full);
  }
  return acc;
}

/** Run an agent CLI for its session list. GUI Electron apps don't inherit
 * the user's shell PATH, so on macOS/Linux we go through a login shell to
 * resolve the (user-installed) agent binary. 10s cap; failures → ''. */
function runAgentCli(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const opts = { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: process.env };
    const done = (out: string) => resolve(out || '');
    if (process.platform === 'win32') {
      execFile(command, args, opts, (_e, stdout) => done(stdout));
    } else {
      const shell = process.env.SHELL || '/bin/zsh';
      const line = [command, ...args.map(shellQuote)].join(' ');
      execFile(shell, ['-lic', line], opts, (_e, stdout) => done(stdout));
    }
  });
}

function shellQuote(a: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}
