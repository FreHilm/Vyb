import { AgentStatus, Profile } from '../shared/types';

function stripAnsi(str: string): string {
  // Strip all ANSI escape sequences: CSI, OSC, DCS, single-char escapes, and cursor sequences
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // CSI sequences
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '') // OSC sequences
    .replace(/\x1B[()][0-9A-B]/g, '') // Character set selection
    .replace(/\x1B[>=<]/g, '') // Keypad/cursor mode
    .replace(/\x1B\[[\?]?[0-9;]*[hlsr]/g, '') // Private mode set/reset
    .replace(/\x1B[78DEHM]/g, '') // Misc single-char sequences
    .replace(/\r/g, ''); // Strip carriage returns
}

interface ProfileState {
  buffer: string;
  status: AgentStatus;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  patterns: {
    ready: RegExp[];
    needsInput: RegExp[];
  };
}

const IDLE_TIMEOUT = 1500; // ms without output → assume ready if currently working
const DEBOUNCE_MS = 400;

export class StatusDetector {
  private states: Map<string, ProfileState> = new Map();
  private onStatusChange: (profileId: string, status: AgentStatus) => void;

  constructor(
    onStatusChange: (profileId: string, status: AgentStatus) => void,
  ) {
    this.onStatusChange = onStatusChange;
  }

  register(profileId: string, profile: Profile): void {
    const readyPatterns = profile.statusPatterns?.ready?.map(
      (p) => new RegExp(p),
    ) ?? [
      /❯/, // Claude Code prompt character anywhere
      /\? for shortcuts/, // Claude Code idle hint
      />\s*$/, // Generic prompt at end
      /\$\s*$/, // Shell prompt at end
    ];

    const needsInputPatterns = profile.statusPatterns?.needsInput?.map(
      (p) => new RegExp(p),
    ) ?? [
      /\(y\/n\)/i,
      /\(Y\)es/,
      /Allow .+\?/i,
      /Do you want/i,
      /\? \(/,
      /approve|deny/i,
    ];

    this.states.set(profileId, {
      buffer: '',
      status: 'offline',
      debounceTimer: null,
      idleTimer: null,
      patterns: {
        ready: readyPatterns,
        needsInput: needsInputPatterns,
      },
    });
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

    state.buffer += data;
    if (state.buffer.length > 2000) {
      state.buffer = state.buffer.slice(-2000);
    }

    // Reset debounce — check patterns after output settles
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this.checkStatus(profileId);
    }, DEBOUNCE_MS);

    // Reset idle timer — if no more data arrives, assume ready
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.status === 'working') {
      state.idleTimer = setTimeout(() => {
        if (state.status === 'working') {
          this.updateStatus(profileId, 'ready');
        }
      }, IDLE_TIMEOUT);
    }
  }

  setWorking(profileId: string): void {
    const state = this.states.get(profileId);
    if (state) {
      // Clear idle timer when we know the agent is working
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    this.updateStatus(profileId, 'working');
  }

  getStatus(profileId: string): AgentStatus {
    return this.states.get(profileId)?.status ?? 'offline';
  }

  private checkStatus(profileId: string): void {
    const state = this.states.get(profileId);
    if (!state) return;

    const cleaned = stripAnsi(state.buffer);
    const lastChunk = cleaned.slice(-500);

    // Check needs-input first (higher priority)
    for (const pattern of state.patterns.needsInput) {
      if (pattern.test(lastChunk)) {
        this.updateStatus(profileId, 'needs-input');
        return;
      }
    }

    // Check ready
    for (const pattern of state.patterns.ready) {
      if (pattern.test(lastChunk)) {
        this.updateStatus(profileId, 'ready');
        return;
      }
    }
  }

  private updateStatus(profileId: string, newStatus: AgentStatus): void {
    const state = this.states.get(profileId);
    if (!state || state.status === newStatus) return;

    state.status = newStatus;
    this.onStatusChange(profileId, newStatus);
  }
}
