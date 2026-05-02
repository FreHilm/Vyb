import { AgentStatus, Profile } from '../shared/types';

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

// ── Agent detection adapters ────────────────────────────────────

interface DetectionResult {
  status: AgentStatus | null; // null = no match, keep current
  immediate?: boolean;        // skip debounce, apply now
}

interface AgentAdapter {
  name: string;
  idleTimeout: number;         // ms before transitioning to ready
  debounceMs: number;          // ms to wait after last data before checking
  detectFromData(data: string, stripped: string, currentStatus: AgentStatus): DetectionResult;
  detectFromBuffer(strippedBuffer: string, rawBuffer: string, currentStatus: AgentStatus): DetectionResult;
}

// ── Claude Code adapter ─────────────────────────────────────────

// Claude spinners for immediate detection on incoming data chunks only.
// Braille chars are unique to spinners; · ✻ ✽ ✶ ✳ ✢ cycle at the cursor.
const CLAUDE_SPINNERS_INCOMING = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✶✳✢]/;

const claudeAdapter: AgentAdapter = {
  name: 'claude-code',
  idleTimeout: 30000,
  debounceMs: 800,

  detectFromData(data: string, stripped: string, currentStatus: AgentStatus): DetectionResult {
    // Immediate: spinner char in the incoming chunk → working
    // Only transition from ready/offline (not from needs-input, to avoid flickering)
    if ((currentStatus === 'ready' || currentStatus === 'offline') && CLAUDE_SPINNERS_INCOMING.test(data)) {
      return { status: 'working', immediate: true };
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer: string, _rawBuffer: string, currentStatus: AgentStatus): DetectionResult {
    // Check only the VERY end of the stripped buffer — old content is stale
    const last = strippedBuffer.slice(-300);

    // Needs-input FIRST. If a permission prompt or interactive picker is
    // present at the bottom of the screen we want to reflect that, even
    // when Claude's persistent "accept edits" / "for shortcuts" footer hint
    // is also somewhere in the last 300 chars.
    for (const pattern of [
      /\(y\/n\)/i,
      /\(Y\)es/,
      /Allow\s*once/i,
      /Allow\s*always/i,
      /Do\s*you\s*want/i,
      /Yes.*No.*Always/,
      /Run\s*command/i,
      /Bash\s*command/i,
      // Interactive picker footer (Ask-me-questions plugin, plan mode menus,
      // permission prompts, etc.). All of Claude's pickers end with a footer
      // line containing "Esc to cancel".
      /Enter\s*to\s*select/i,
      /Esc\s*to\s*cancel/i,
    ]) {
      if (pattern.test(last)) return { status: 'needs-input' };
    }

    // Ready patterns — Claude's idle hints
    if (/for\s*shortcuts/.test(last)) return { status: 'ready' };
    if (/accept\s*edits/i.test(last)) return { status: 'ready' };
    if (/❯\s*$/.test(last)) return { status: 'ready' };

    // If we were working and the debounce fired (no new data for 800ms)
    // but no ready/needs-input pattern matched, Claude likely just finished
    // outputting a long response. Transition to ready — don't wait 30s.
    if (currentStatus === 'working') return { status: 'ready' };

    return { status: null };
  },
};

// ── Codex adapter ───────────────────────────────────────────────

const codexAdapter: AgentAdapter = {
  name: 'codex',
  idleTimeout: 3000,
  debounceMs: 500,

  detectFromData(data: string, stripped: string, currentStatus: AgentStatus): DetectionResult {
    // Codex TUI: interrupt hint means working
    if (/esc to interrupt|Escape to cancel|Ctrl\+C to stop/i.test(stripped)) {
      return { status: 'working', immediate: true };
    }
    // Once working, hold that state — don't downgrade on non-matching chunks.
    // The idle timeout (3s) handles the transition to ready.
    return { status: null };
  },

  detectFromBuffer(_strippedBuffer: string, _rawBuffer: string, currentStatus: AgentStatus): DetectionResult {
    // Codex attention is not detected from output — solely via idle timeout.
    // Only check for working hints to reinforce the working state.
    const last = _strippedBuffer.slice(-800);
    if (/esc to interrupt|Escape to cancel|Ctrl\+C to stop/i.test(last)) {
      return { status: 'working' };
    }
    return { status: null };
  },
};

// ── Gemini adapter ──────────────────────────────────────────────
// Gemini CLI uses an Ink TUI that redraws entire screen sections in bursts.
// Large output chunks indicate active streaming. Small chunks are idle noise.
// Startup takes 7+ seconds (Ink TUI + Node.js bundle).

const geminiAdapter: AgentAdapter = {
  name: 'gemini',
  idleTimeout: 3000,
  debounceMs: 500,

  detectFromData(data: string, stripped: string): DetectionResult {
    // Large stripped chunks (>50 chars) indicate active streaming
    if (stripped.length > 50) {
      return { status: 'working', immediate: true };
    }
    // Small chunks = idle cursor/redraw noise — don't change status
    return { status: null };
  },

  detectFromBuffer(strippedBuffer: string): DetectionResult {
    const last = strippedBuffer.slice(-800);

    // Approval prompts → needs-input
    if (/Approve\?\s*\(y\/n(?:\/always)?\)/i.test(last)) return { status: 'needs-input' };

    // Everything else handled by idle timeout (3s → ready)
    return { status: null };
  },
};

// ── Generic/fallback adapter ────────────────────────────────────

const genericAdapter: AgentAdapter = {
  name: 'generic',
  idleTimeout: 60000,
  debounceMs: 800,

  detectFromData(data: string, stripped: string, currentStatus: AgentStatus): DetectionResult {
    // Braille spinners → working
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(data)) {
      return { status: 'working', immediate: true };
    }
    // Claude-style spinners as fallback
    if (CLAUDE_SPINNERS_INCOMING.test(stripped)) {
      return { status: 'working', immediate: true };
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer: string, rawBuffer: string): DetectionResult {
    const last = strippedBuffer.slice(-800);
    const rawLast = rawBuffer.slice(-1000);

    // Needs-input patterns
    if (/\(y\/n\)/i.test(last)) return { status: 'needs-input' };
    if (/\[Y\/n\]|\[y\/N\]/.test(last)) return { status: 'needs-input' };
    if (/Allow\s*(once|always)/i.test(last)) return { status: 'needs-input' };
    if (/Do\s*you\s*want/i.test(last)) return { status: 'needs-input' };
    if (/Yes.*No.*Always/.test(last)) return { status: 'needs-input' };

    // Working: spinners in raw
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(rawLast)) return { status: 'working' };
    if (CLAUDE_SPINNERS_INCOMING.test(rawLast)) return { status: 'working' };

    // Ready patterns
    if (/for\s*shortcuts/.test(last)) return { status: 'ready' };
    if (/❯/.test(last.slice(-20))) return { status: 'ready' };
    if (/\$\s*$/.test(last)) return { status: 'ready' };

    return { status: null };
  },
};

// ── Adapter selection ───────────────────────────────────────────

function getAdapter(command: string): AgentAdapter {
  const cmd = command.toLowerCase();
  if (cmd === 'claude' || cmd.endsWith('/claude')) return claudeAdapter;
  if (cmd === 'codex' || cmd.endsWith('/codex')) return codexAdapter;
  if (cmd === 'gemini' || cmd.endsWith('/gemini')) return geminiAdapter;
  return genericAdapter;
}

// ── Status Detector ─────────────────────────────────────────────

const STARTUP_GRACE_MS = 5000; // 5s grace period after terminal creation

interface ProfileState {
  buffer: string;
  rawBuffer: string;
  status: AgentStatus;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  adapter: AgentAdapter;
  lastDataTime: number;
  createdAt: number;
  // Used to suppress the "has updates" bell on phantom working→ready
  // transitions (e.g. caused by terminal resize redraws or rapid profile
  // switching). Only counts real activity that lasted long enough OR
  // produced enough new newlines.
  workingStartedAt: number;
  totalNewlines: number;
  newlinesAtWorkingStart: number;
}

// A working→ready transition only counts as "real activity" (and triggers
// the bell indicator) if at least one of these is true:
//   - the working state lasted MIN_WORKING_DURATION_MS or longer
//   - at least MIN_NEWLINES_FOR_ACTIVITY new lines were committed during it
// Resize-triggered redraws and rapid profile switches typically flicker the
// status under both thresholds and therefore won't fire the bell.
const MIN_WORKING_DURATION_MS = 1500;
const MIN_NEWLINES_FOR_ACTIVITY = 4;

export class StatusDetector {
  private states: Map<string, ProfileState> = new Map();
  private onStatusChange: (
    profileId: string,
    status: AgentStatus,
    previousStatus: AgentStatus,
    output: string,
    hasNewContent: boolean,
  ) => void;

  constructor(
    onStatusChange: (
      profileId: string,
      status: AgentStatus,
      previousStatus: AgentStatus,
      output: string,
      hasNewContent: boolean,
    ) => void,
  ) {
    this.onStatusChange = onStatusChange;
  }

  register(profileId: string, profile: Profile): void {
    const adapter = getAdapter(profile.command);

    this.states.set(profileId, {
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

    // Emit initial ready status so the renderer shows green immediately
    this.onStatusChange(profileId, 'ready', 'offline', '', false);
  }

  unregister(profileId: string): void {
    const state = this.states.get(profileId);
    if (state) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    this.states.delete(profileId);
  }

  feedData(profileId: string, data: string): void {
    const state = this.states.get(profileId);
    if (!state) return;

    state.lastDataTime = Date.now();

    // Keep raw data for spinner detection
    state.rawBuffer += data;
    if (state.rawBuffer.length > 4000) {
      state.rawBuffer = state.rawBuffer.slice(-4000);
    }

    // Stripped buffer for text pattern matching
    const stripped = stripAnsi(data);
    state.buffer += stripped;
    if (state.buffer.length > 2000) {
      state.buffer = state.buffer.slice(-2000);
    }

    // Cumulative newline count — survives buffer rolling. Used to decide if
    // a working→ready transition involved real new output (vs. a redraw).
    let n = -1;
    while ((n = stripped.indexOf('\n', n + 1)) !== -1) state.totalNewlines++;

    // Check for immediate detection (spinners, interrupt hints)
    const immediate = state.adapter.detectFromData(data, stripped, state.status);
    if (immediate.status && immediate.immediate) {
      this.updateStatus(profileId, immediate.status);
    }

    // Reset idle timer
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      // Idle timeout: if still working, transition to ready
      if (state.status === 'working') {
        this.updateStatus(profileId, 'ready');
      }
    }, state.adapter.idleTimeout);

    // Debounced full check
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this.checkStatus(profileId);
    }, state.adapter.debounceMs);
  }

  setWorking(profileId: string): void {
    this.updateStatus(profileId, 'working');
  }

  getStatus(profileId: string): AgentStatus {
    return this.states.get(profileId)?.status ?? 'offline';
  }

  getAll(): Record<string, AgentStatus> {
    const out: Record<string, AgentStatus> = {};
    for (const [id, state] of this.states) {
      out[id] = state.status;
    }
    return out;
  }

  private checkStatus(profileId: string): void {
    const state = this.states.get(profileId);
    if (!state) return;

    const result = state.adapter.detectFromBuffer(state.buffer, state.rawBuffer, state.status);
    if (result.status) {
      this.updateStatus(profileId, result.status);
    }
  }

  private updateStatus(profileId: string, newStatus: AgentStatus): void {
    const state = this.states.get(profileId);
    if (!state || state.status === newStatus) return;

    // Startup grace period: during the first 20s, suppress working/needs-input
    // transitions — the agent is still initializing (welcome banner, loading, etc.)
    // Only allow transition to ready (first idle detection after startup)
    if (Date.now() - state.createdAt < STARTUP_GRACE_MS) {
      if (newStatus !== 'ready') return;
    }

    const oldStatus = state.status;
    const output = state.buffer;

    // Decide whether this transition represents a real change worth notifying
    // about (lights the renderer's bell indicator). For working→ready, gate
    // on duration AND output volume — a redraw flicker stays under both.
    let hasNewContent = true;
    if (newStatus === 'working') {
      state.workingStartedAt = Date.now();
      state.newlinesAtWorkingStart = state.totalNewlines;
      // 'working' itself never lights the bell — only the transition out of it.
      hasNewContent = false;
    } else if (oldStatus === 'working' && newStatus === 'ready') {
      const duration = Date.now() - state.workingStartedAt;
      const newlinesAdded = state.totalNewlines - state.newlinesAtWorkingStart;
      hasNewContent =
        duration >= MIN_WORKING_DURATION_MS ||
        newlinesAdded >= MIN_NEWLINES_FOR_ACTIVITY;
    }

    state.status = newStatus;
    this.onStatusChange(profileId, newStatus, oldStatus, output, hasNewContent);
  }
}
