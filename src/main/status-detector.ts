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

interface ProfileState {
  buffer: string;
  rawBuffer: string;
  status: AgentStatus;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  patterns: {
    ready: RegExp[];
    needsInput: RegExp[];
    working: RegExp[];
  };
  lastDataTime: number;
}

const DEBOUNCE_MS = 800;

export class StatusDetector {
  private states: Map<string, ProfileState> = new Map();
  private onStatusChange: (profileId: string, status: AgentStatus, previousStatus: AgentStatus, output: string) => void;

  constructor(
    onStatusChange: (profileId: string, status: AgentStatus, previousStatus: AgentStatus, output: string) => void,
  ) {
    this.onStatusChange = onStatusChange;
  }

  register(profileId: string, profile: Profile): void {
    const readyPatterns = profile.statusPatterns?.ready?.map(
      (p) => new RegExp(p),
    ) ?? [
      /for\s*shortcuts/,
      /❯/,
      /\$\s*$/,
    ];

    const needsInputPatterns = profile.statusPatterns?.needsInput?.map(
      (p) => new RegExp(p),
    ) ?? [
      /\(y\/n\)/i,
      /\(Y\)es/,
      /Allow\s*once/i,
      /Allow\s*always/i,
      /Do\s*you\s*want/i,
      /approve|deny/i,
      /Yes.*No.*Always/,
      /Run\s*command/i,
      /Bash\s*command/i,
    ];

    // Patterns checked on BOTH raw and stripped buffers to detect active work
    const workingPatterns = [
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Spinner braille chars
    ];

    this.states.set(profileId, {
      buffer: '',
      rawBuffer: '',
      status: 'offline',
      debounceTimer: null,
      patterns: {
        ready: readyPatterns,
        needsInput: needsInputPatterns,
        working: workingPatterns,
      },
      lastDataTime: 0,
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

    // If currently ready/offline and we're receiving data, check raw for spinners
    // to transition to working immediately (don't wait for debounce)
    if (state.status === 'ready' || state.status === 'offline') {
      for (const pattern of state.patterns.working) {
        if (pattern.test(data)) {
          this.updateStatus(profileId, 'working');
          break;
        }
      }
    }

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this.checkStatus(profileId);
    }, DEBOUNCE_MS);
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

    const lastChunk = state.buffer.slice(-500);
    const rawChunk = state.rawBuffer.slice(-1000);

    // Check needs-input (highest priority)
    for (const pattern of state.patterns.needsInput) {
      if (pattern.test(lastChunk)) {
        this.updateStatus(profileId, 'needs-input');
        return;
      }
    }

    // Check spinners in raw buffer (they may be stripped from the clean buffer)
    for (const pattern of state.patterns.working) {
      if (pattern.test(rawChunk)) {
        this.updateStatus(profileId, 'working');
        return;
      }
    }

    // Check ready patterns on stripped text
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

    const oldStatus = state.status;
    const output = state.buffer;
    state.status = newStatus;
    this.onStatusChange(profileId, newStatus, oldStatus, output);
  }
}
