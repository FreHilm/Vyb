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

const codexAdapter: AgentAdapter = {
  name: 'codex',
  idleTimeout: 3000,
  debounceMs: 500,

  detectFromData(_data, stripped, _currentStatus) {
    if (/esc to interrupt|Escape to cancel|Ctrl\+C to stop/i.test(stripped)) {
      return { status: 'working', immediate: true };
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer, _rawBuffer, _currentStatus) {
    const last = strippedBuffer.slice(-800);
    if (/esc to interrupt|Escape to cancel|Ctrl\+C to stop/i.test(last)) {
      return { status: 'working' };
    }
    return { status: null };
  },
};

const geminiAdapter: AgentAdapter = {
  name: 'gemini',
  idleTimeout: 3000,
  debounceMs: 500,

  detectFromData(_data, stripped) {
    if (stripped.length > 50) {
      return { status: 'working', immediate: true };
    }
    return { status: null };
  },

  detectFromBuffer(strippedBuffer) {
    const last = strippedBuffer.slice(-800);
    if (/Approve\?\s*\(y\/n(?:\/always)?\)/i.test(last)) return { status: 'needs-input' };
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

function getAdapter(command: string): AgentAdapter {
  const cmd = command.toLowerCase();
  if (cmd === 'claude' || cmd.endsWith('/claude')) return claudeAdapter;
  if (cmd === 'codex' || cmd.endsWith('/codex')) return codexAdapter;
  if (cmd === 'gemini' || cmd.endsWith('/gemini')) return geminiAdapter;
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
