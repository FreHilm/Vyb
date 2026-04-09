import { AgentStatus, Profile } from '../shared/types';

function stripAnsi(str: string): string {
  // Strips ANSI escape codes including CSI, OSC, and single-char escapes
  return str.replace(
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g,
    '',
  );
}

interface ProfileState {
  buffer: string;
  status: AgentStatus;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  patterns: {
    ready: RegExp[];
    needsInput: RegExp[];
  };
}

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
    ) ?? [/[❯>]\s*$/, /\$\s*$/];

    const needsInputPatterns = profile.statusPatterns?.needsInput?.map(
      (p) => new RegExp(p),
    ) ?? [/\(y\/n\)/i, /Allow .+\?/i, /Do you want/i, /\? \(/];

    this.states.set(profileId, {
      buffer: '',
      status: 'offline',
      debounceTimer: null,
      patterns: {
        ready: readyPatterns,
        needsInput: needsInputPatterns,
      },
    });
  }

  unregister(profileId: string): void {
    const state = this.states.get(profileId);
    if (state?.debounceTimer) clearTimeout(state.debounceTimer);
    this.states.delete(profileId);
  }

  feedData(profileId: string, data: string): void {
    const state = this.states.get(profileId);
    if (!state) return;

    state.buffer += data;
    if (state.buffer.length > 1000) {
      state.buffer = state.buffer.slice(-1000);
    }

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this.checkStatus(profileId);
    }, 300);
  }

  setWorking(profileId: string): void {
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
    state.buffer = '';
    this.onStatusChange(profileId, newStatus);
  }
}
