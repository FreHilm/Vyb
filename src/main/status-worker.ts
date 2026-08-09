/**
 * Status detection worker.
 *
 * Runs on its own Node.js worker thread so the regex-heavy ANSI strip and
 * pattern matching doesn't block the Electron main thread that's also
 * dispatching PTY I/O and IPC messages.
 *
 * Message protocol (parent → worker):
 *   { type: 'register',   profileId, command }
 *   { type: 'unregister', profileId }
 *   { type: 'feed',       profileId, data }
 *   { type: 'setWorking', profileId }
 *
 * Message protocol (worker → parent):
 *   { type: 'statusChange', profileId, status, previousStatus, output, hasNewContent }
 */

import { parentPort } from 'worker_threads';

if (!parentPort) {
  throw new Error('status-worker must be spawned as a worker_thread');
}
const port = parentPort;

type AgentStatus = 'offline' | 'ready' | 'working' | 'needs-input';

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[()][0-9A-B]/g, '')
    .replace(/\x1B[>=<]/g, '')
    .replace(/\x1B[78DEHM]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\r/g, '');
}

interface DetectionResult {
  status: AgentStatus | null;
  immediate?: boolean;
}

interface AgentAdapter {
  name: string;
  idleTimeout: number;
  debounceMs: number;
  detectFromData(data: string, stripped: string, currentStatus: AgentStatus): DetectionResult;
  detectFromBuffer(strippedBuffer: string, rawBuffer: string, currentStatus: AgentStatus): DetectionResult;
}

const CLAUDE_SPINNERS_INCOMING = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✶✳✢]/;

const claudeAdapter: AgentAdapter = {
  name: 'claude-code',
  idleTimeout: 30000,
  debounceMs: 800,

  detectFromData(data, _stripped, currentStatus) {
    if ((currentStatus === 'ready' || currentStatus === 'offline') && CLAUDE_SPINNERS_INCOMING.test(data)) {
      return { status: 'working', immediate: true };
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer, _rawBuffer, currentStatus) {
    const last = strippedBuffer.slice(-300);

    for (const pattern of [
      /\(y\/n\)/i,
      /\(Y\)es/,
      /Allow\s*once/i,
      /Allow\s*always/i,
      /Do\s*you\s*want/i,
      /Yes.*No.*Always/,
      /Run\s*command/i,
      /Bash\s*command/i,
      /Enter\s*to\s*select/i,
      /Esc\s*to\s*cancel/i,
    ]) {
      if (pattern.test(last)) return { status: 'needs-input' };
    }

    if (/for\s*shortcuts/.test(last)) return { status: 'ready' };
    if (/accept\s*edits/i.test(last)) return { status: 'ready' };
    if (/❯\s*$/.test(last)) return { status: 'ready' };

    if (currentStatus === 'working') return { status: 'ready' };

    return { status: null };
  },
};

// ── Codex adapter ───────────────────────────────────────────────
//
// Codex is non-interactive — it never blocks on a y/n prompt, so we
// don't detect `needs-input`. The lifecycle we care about is:
//
//   1. "Working (4s • esc to interrupt)" footer appears → working
//      (the leading word and the seconds/min/h counter vary between
//      Codex versions; the trailing "esc to interrupt" is the stable
//      giveaway)
//   2. Footer disappears, but Codex keeps emitting trailing lines
//      (final summary, file list, etc.) for a moment afterwards
//   3. Output stops → ready
//
// We rely entirely on the idle timer to flip working→ready: each
// chunk resets `idleTimer`, so as long as trailing lines keep
// arriving the transition is held off. Once the PTY truly quiets
// down for `idleTimeout` ms, ready fires. `idleTimeout` is bumped to
// 4 s to comfortably cover Codex's trailing-output burst.
const CODEX_WORKING_HINT =
  /esc\s*to\s*interrupt|esc\s*interrupt|Escape\s*to\s*cancel|Ctrl\+C\s*to\s*stop|Working\s*\(\s*\d/i;

const codexAdapter: AgentAdapter = {
  name: 'codex',
  idleTimeout: 4000,
  debounceMs: 500,

  detectFromData(_data, stripped, currentStatus) {
    if (currentStatus === 'ready' || currentStatus === 'offline') {
      if (CODEX_WORKING_HINT.test(stripped)) {
        return { status: 'working', immediate: true };
      }
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer, _rawBuffer, _currentStatus) {
    // Reinforce working from the buffer tail. The per-chunk detector above
    // misses the footer when Codex resumes after a lull (the idle timer has
    // already flipped us to `ready`, and the resume often repaints only the
    // seconds counter, or the "esc to interrupt" line is fragmented across
    // coalesced chunks) — that's the "not always recognised as running" bug.
    // The footer always sits at the bottom, so only the tail is inspected. A
    // stale hint further up the buffer can't keep us stuck working: `ready`
    // is driven entirely by the idle timer, and the single post-data debounce
    // re-asserting `working` is a no-op once we're already working.
    const tail = strippedBuffer.slice(-400);
    if (CODEX_WORKING_HINT.test(tail)) return { status: 'working' };
    return { status: null };
  },
};

// ── Gemini adapter ──────────────────────────────────────────────
//
// Working footer:   "Initiating Task Execution (esc to cancel, 26s)"
//                   — the comma + seconds counter is the dead giveaway
// Needs-input cues:
//   • "Apply this change?" with numbered list (Allow once / Allow for
//     this session / Modify with external editor / No, suggest changes)
//   • "Answer Questions" panel with footer
//     "Enter to select · ↑/↓ to navigate · Esc to cancel"
//   • Classic "Approve? (y/n/always)" prompt
const geminiAdapter: AgentAdapter = {
  name: 'gemini',
  idleTimeout: 4000,
  debounceMs: 500,

  detectFromData(_data, stripped, currentStatus) {
    if (currentStatus === 'ready' || currentStatus === 'offline') {
      if (/\(esc\s*to\s*cancel,?\s*\d+\s*s\)/i.test(stripped)) {
        return { status: 'working', immediate: true };
      }
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer, _rawBuffer, _currentStatus) {
    const last = strippedBuffer.slice(-1200);

    if (/Apply\s*this\s*change\?/i.test(last)) return { status: 'needs-input' };
    if (/Answer\s*Questions/i.test(last)) return { status: 'needs-input' };
    if (/Enter\s*to\s*select.*to\s*navigate/is.test(last)) return { status: 'needs-input' };
    if (/Allow\s*once/i.test(last) && /Allow\s*for\s*this\s*session/i.test(last)) {
      return { status: 'needs-input' };
    }
    if (/Approve\?\s*\(y\/n(?:\/always)?\)/i.test(last)) return { status: 'needs-input' };

    return { status: null };
  },
};

// ── OpenCode adapter ────────────────────────────────────────────
//
// Detection cues from observed OpenCode TUI output:
//   working      → "esc interrupt" footer hint at bottom of screen
//   needs-input  → multi-choice picker footer ("enter submit" + "esc dismiss")
//                  or numbered selectable list with "↑↓ select"
//   ready        → footer reads only "ctrl+p commands" (no esc interrupt,
//                  no interactive picker)
const opencodeAdapter: AgentAdapter = {
  name: 'opencode',
  idleTimeout: 5000,
  debounceMs: 600,

  detectFromData(_data, stripped, currentStatus) {
    if (currentStatus === 'ready' || currentStatus === 'offline') {
      if (/esc\s*(to\s*)?interrupt/i.test(stripped)) {
        return { status: 'working', immediate: true };
      }
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer, _rawBuffer, currentStatus) {
    const last = strippedBuffer.slice(-800);

    // Interactive picker / multi-choice question — bottom footer
    if (/enter\s*submit.*esc\s*dismiss/is.test(last)) return { status: 'needs-input' };
    if (/esc\s*dismiss.*enter\s*submit/is.test(last)) return { status: 'needs-input' };
    // Yes/No style approval prompts (defensive — opencode also uses these)
    if (/\(y\/n\)/i.test(last)) return { status: 'needs-input' };

    // Active "esc interrupt" hint reinforces working
    if (/esc\s*(to\s*)?interrupt/i.test(last)) return { status: 'working' };

    // Idle footer — "ctrl+p commands" without "esc interrupt" means done
    if (/ctrl\+p\s*commands/i.test(last) && !/esc\s*(to\s*)?interrupt/i.test(last)) {
      return { status: 'ready' };
    }

    // Generic finish-from-working: if the debounce fires while we were
    // working but no further hints are present, treat as ready.
    if (currentStatus === 'working') return { status: 'ready' };

    return { status: null };
  },
};

const genericAdapter: AgentAdapter = {
  name: 'generic',
  idleTimeout: 60000,
  debounceMs: 800,

  detectFromData(data, stripped) {
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(data)) {
      return { status: 'working', immediate: true };
    }
    if (CLAUDE_SPINNERS_INCOMING.test(stripped)) {
      return { status: 'working', immediate: true };
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer, rawBuffer) {
    const last = strippedBuffer.slice(-800);
    const rawLast = rawBuffer.slice(-1000);

    if (/\(y\/n\)/i.test(last)) return { status: 'needs-input' };
    if (/\[Y\/n\]|\[y\/N\]/.test(last)) return { status: 'needs-input' };
    if (/Allow\s*(once|always)/i.test(last)) return { status: 'needs-input' };
    if (/Do\s*you\s*want/i.test(last)) return { status: 'needs-input' };
    if (/Yes.*No.*Always/.test(last)) return { status: 'needs-input' };

    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(rawLast)) return { status: 'working' };
    if (CLAUDE_SPINNERS_INCOMING.test(rawLast)) return { status: 'working' };

    if (/for\s*shortcuts/.test(last)) return { status: 'ready' };
    if (/❯/.test(last.slice(-20))) return { status: 'ready' };
    if (/\$\s*$/.test(last)) return { status: 'ready' };

    return { status: null };
  },
};

// Plain-terminal profiles (empty command → the user's login shell).
// Deliberately quiet: a shell is always "ready" from the status system's
// point of view — no working spinner, so slow commands never trigger the
// completion bell, and no needs-input heuristics that would misfire on
// ordinary prompt output.
const terminalAdapter: AgentAdapter = {
  name: 'terminal',
  idleTimeout: 60000,
  debounceMs: 800,

  detectFromData() {
    return { status: null };
  },

  detectFromBuffer() {
    return { status: 'ready' };
  },
};

function getAdapter(command: string): AgentAdapter {
  const cmd = command.toLowerCase();
  if (!cmd.trim()) return terminalAdapter;
  if (cmd === 'claude' || cmd.endsWith('/claude')) return claudeAdapter;
  if (cmd === 'codex' || cmd.endsWith('/codex')) return codexAdapter;
  if (cmd === 'gemini' || cmd.endsWith('/gemini')) return geminiAdapter;
  if (cmd === 'opencode' || cmd.endsWith('/opencode')) return opencodeAdapter;
  return genericAdapter;
}

const STARTUP_GRACE_MS = 5000;
const MIN_WORKING_DURATION_MS = 1500;
const MIN_NEWLINES_FOR_ACTIVITY = 4;

interface ProfileState {
  buffer: string;
  rawBuffer: string;
  status: AgentStatus;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  adapter: AgentAdapter;
  lastDataTime: number;
  createdAt: number;
  workingStartedAt: number;
  totalNewlines: number;
  newlinesAtWorkingStart: number;
}

const states: Map<string, ProfileState> = new Map();

function emitStatusChange(
  profileId: string,
  status: AgentStatus,
  previousStatus: AgentStatus,
  output: string,
  hasNewContent: boolean,
): void {
  port.postMessage({
    type: 'statusChange',
    profileId,
    status,
    previousStatus,
    output,
    hasNewContent,
  });
}

function updateStatus(profileId: string, newStatus: AgentStatus): void {
  const state = states.get(profileId);
  if (!state || state.status === newStatus) return;

  if (Date.now() - state.createdAt < STARTUP_GRACE_MS) {
    if (newStatus !== 'ready') return;
  }

  const oldStatus = state.status;
  const output = state.buffer;

  let hasNewContent = true;
  if (newStatus === 'working') {
    state.workingStartedAt = Date.now();
    state.newlinesAtWorkingStart = state.totalNewlines;
    hasNewContent = false;
  } else if (oldStatus === 'working' && newStatus === 'ready') {
    const duration = Date.now() - state.workingStartedAt;
    const newlinesAdded = state.totalNewlines - state.newlinesAtWorkingStart;
    hasNewContent =
      duration >= MIN_WORKING_DURATION_MS ||
      newlinesAdded >= MIN_NEWLINES_FOR_ACTIVITY;
  }

  state.status = newStatus;
  emitStatusChange(profileId, newStatus, oldStatus, output, hasNewContent);
}

function checkStatus(profileId: string): void {
  const state = states.get(profileId);
  if (!state) return;
  const result = state.adapter.detectFromBuffer(state.buffer, state.rawBuffer, state.status);
  if (result.status) updateStatus(profileId, result.status);
}

function register(profileId: string, command: string): void {
  const adapter = getAdapter(command);
  states.set(profileId, {
    buffer: '',
    rawBuffer: '',
    status: 'ready',
    debounceTimer: null,
    idleTimer: null,
    adapter,
    lastDataTime: 0,
    createdAt: Date.now(),
    workingStartedAt: 0,
    totalNewlines: 0,
    newlinesAtWorkingStart: 0,
  });
  emitStatusChange(profileId, 'ready', 'offline', '', false);
}

function unregister(profileId: string): void {
  const state = states.get(profileId);
  if (state) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
  }
  states.delete(profileId);
}

function feedData(profileId: string, data: string): void {
  const state = states.get(profileId);
  if (!state) return;

  state.lastDataTime = Date.now();

  state.rawBuffer += data;
  if (state.rawBuffer.length > 4000) {
    state.rawBuffer = state.rawBuffer.slice(-4000);
  }

  const stripped = stripAnsi(data);
  state.buffer += stripped;
  if (state.buffer.length > 2000) {
    state.buffer = state.buffer.slice(-2000);
  }

  let n = -1;
  while ((n = stripped.indexOf('\n', n + 1)) !== -1) state.totalNewlines++;

  const immediate = state.adapter.detectFromData(data, stripped, state.status);
  if (immediate.status && immediate.immediate) {
    updateStatus(profileId, immediate.status);
  }

  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (state.status === 'working') updateStatus(profileId, 'ready');
  }, state.adapter.idleTimeout);

  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => checkStatus(profileId), state.adapter.debounceMs);
}

function setWorking(profileId: string): void {
  updateStatus(profileId, 'working');
}

type IncomingMessage =
  | { type: 'register'; profileId: string; command: string }
  | { type: 'unregister'; profileId: string }
  | { type: 'feed'; profileId: string; data: string }
  | { type: 'setWorking'; profileId: string };

port.on('message', (msg: IncomingMessage) => {
  switch (msg.type) {
    case 'register': register(msg.profileId, msg.command); break;
    case 'unregister': unregister(msg.profileId); break;
    case 'feed': feedData(msg.profileId, msg.data); break;
    case 'setWorking': setWorking(msg.profileId); break;
  }
});
