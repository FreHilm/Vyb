import { AgentStatus, Profile } from '../shared/types';

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[()][0-9A-B]/g, '')
    .replace(/\x1B[>=<]/g, '')
    .replace(/\x1B[78DEHM]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // strip remaining control chars
    .replace(/\r/g, '');
}

// Extract OSC terminal title sequences from raw data
function extractOscTitles(data: string): string[] {
  const titles: string[] = [];
  const re = /\x1B\](?:0|2);([^\x07\x1B]*?)(?:\x07|\x1B\\)/g;
  let match;
  while ((match = re.exec(data)) !== null) {
    titles.push(match[1]);
  }
  return titles;
}

interface ProfileState {
  buffer: string;
  rawBuffer: string; // keeps raw data for OSC extraction
  status: AgentStatus;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  patterns: {
    ready: RegExp[];
    needsInput: RegExp[];
    working: RegExp[];
  };
}

const DEBOUNCE_MS = 800;

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
      /for\s*shortcuts/,          // Claude Code idle hint (spaces may be stripped)
      /❯/,                        // Claude Code prompt character
      /\$\s*$/,                   // Shell prompt at end of buffer
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
      /Yes.*No.*Always/,            // Claude Code permission button row
      /Run\s*command/i,
      /Bash\s*command/i,
    ];

    const workingPatterns = [
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
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

    // Keep raw data for OSC title extraction
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

    // Check needs-input (highest priority)
    for (const pattern of state.patterns.needsInput) {
      if (pattern.test(lastChunk)) {
        this.updateStatus(profileId, 'needs-input');
        return;
      }
    }

    // 3. If working, check spinner to stay working
    if (state.status === 'working') {
      for (const pattern of state.patterns.working) {
        if (pattern.test(lastChunk)) {
          return;
        }
      }
    }

    // 4. Check ready patterns on stripped text
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
