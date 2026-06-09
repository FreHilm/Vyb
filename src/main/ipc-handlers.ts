import { app, ipcMain, shell, dialog, BrowserWindow, Notification, webContents, Menu } from 'electron';
import { exec, execSync, execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout, GitStatus, GitCommit, GitRef, GitCheckoutResult, GitCommitResult, GitOpResult, GitMergeResult, GitMergePreviewResult, GitRebaseResult, GitCreatePrResult, GitStash, FileEntry, ProfileMemoryMap, OrdnaTaskPayload, ParallelAgent, resolveAgent, DEFAULT_AGENTS } from '../shared/types';
import { PtyManager } from './pty-manager';
import { StatusDetector } from './status-detector';
import { loadProfiles, saveProfiles, loadSettings, saveSettings, loadLayout, saveLayout, loadProfileMemory, saveProfileMemory, loadScrollback, saveScrollback } from './config-loader';
import * as ordnaHookServer from './ordna-hook-server';
import { OrdnaManager } from './ordna-manager';
import { ParallelAgentManager } from './parallel-agent-manager';
import { applyAgentArgsGuards } from './agent-args-guard';
import { sendCtrlCToPty, clearCtrlCState } from './windows-ctrlc';


let ptyManager: PtyManager;
let statusDetector: StatusDetector;
let ordnaManager: OrdnaManager;
let parallelManager: ParallelAgentManager;
let mainWindow: BrowserWindow;
let profiles: Profile[] = [];
let isQuitting = false;
const scrollbackBuffers: Map<string, string> = new Map();
const shellHadInput: Set<string> = new Set(); // tracks shells where user typed commands
const MAX_BUFFER = 512 * 1024;
let activeProfileId: string | null = null;
let activeParallelAgentId: string | null = null;

// Flow control — prevent renderer flooding on fast terminal output
const FLOW_HIGH_WATERMARK = 256 * 1024;
const FLOW_LOW_WATERMARK = 64 * 1024;

interface FlowState {
  pending: number;  // bytes in flight (UTF-8) the renderer hasn't ACKed yet
  paused: boolean;
  buffer: string[];
}
const flowStates: Map<string, FlowState> = new Map();

// PTY data is encoded to UTF-8 bytes once per coalesced batch before being
// pushed across IPC. Sending Uint8Array instead of string skips the structured-
// clone path that internally re-encodes UTF-16 strings, and lets xterm.js
// consume bytes directly on the renderer side without re-decoding.
const ipcEncoder = new TextEncoder();

// PTY-data coalescing — chatty agents emit dozens of tiny chunks per second
// (one per ANSI sequence, prompt redraw, spinner tick, etc.). Each chunk
// previously triggered: stripAnsi + status-detector regex pass + IPC send +
// renderer ack. Coalescing collects chunks within a short window or up to a
// small byte budget before flushing as a single batch, preserving byte order.
//
// These thresholds match VS Code's terminal pipeline (`TerminalProcess`):
// 5 ms / 5 KB. The smaller byte budget produces more, smaller IPC messages
// during bulk output, which lets the xterm.js parser render incrementally
// across more frames — long streamed responses "pour in" instead of arriving
// in visible blocks. Below ~3 KB the IPC fixed cost would start to dominate;
// 5 KB is the sweet spot they validated in production.
const COALESCE_WINDOW_MS = 5;
const COALESCE_MAX_BYTES = 5 * 1024;

interface CoalesceState {
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}
const coalesceStates: Map<string, CoalesceState> = new Map();

// A resize sends SIGWINCH, which makes full-screen agents (notably Claude
// Code) repaint their entire view. That burst trips the status detector's
// "working" heuristic (spinner glyphs / large chunk) and the agent
// spuriously flips to "working" (blue flames) just from dragging the
// window. We suppress status detection for a short window after each
// resize so a pure redraw isn't mistaken for real activity. The window
// extends on every resize event, covering the whole drag plus the repaint.
const resizeQuietUntil: Map<string, number> = new Map();
const RESIZE_STATUS_QUIET_MS = 600;

let processBatch: (profileId: string, data: string) => void = () => undefined;

function flushCoalesced(profileId: string): void {
  const state = coalesceStates.get(profileId);
  if (!state) return;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.pending.length === 0) return;
  const data = state.pending;
  state.pending = '';
  processBatch(profileId, data);
}

function queueData(profileId: string, data: string): void {
  let state = coalesceStates.get(profileId);
  if (!state) {
    state = { pending: '', flushTimer: null };
    coalesceStates.set(profileId, state);
  }
  state.pending += data;
  // Flush early on size threshold to keep latency bounded for huge bursts
  if (state.pending.length >= COALESCE_MAX_BYTES) {
    flushCoalesced(profileId);
    return;
  }
  if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => flushCoalesced(profileId), COALESCE_WINDOW_MS);
  }
}

function clearCoalesced(profileId: string): void {
  const state = coalesceStates.get(profileId);
  if (!state) return;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  coalesceStates.delete(profileId);
}

function safeSend(channel: string, payload: unknown): void {
  if (isQuitting || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch {
    // Window already destroyed during shutdown
  }
}

// ── Async git command runner + dedupe / cache (perf) ───────────────
//
// Replaces the per-handler execSync chains. Each git call now goes
// through `execFile` (async), so the main process event loop can keep
// processing PTY data + IPC while git is running. Sequential chains
// in the same handler get the additional benefit of running in
// parallel via Promise.all where dependencies allow.
//
// In-flight dedup: a second call to GIT_STATUS / GIT_CHANGED_FILES
// for the same cwd while a previous one is in flight reuses that
// promise instead of starting a fresh one. StatusBar + the file-tree
// decorations poll fire close together; before this they'd both
// spawn the full chain.
//
// Short TTL cache: GIT_STATUS results stay valid for 1.5 s so two
// nearby polls share a single git invocation. GIT_CHANGED_FILES is
// mutation-sensitive (commit / stage / unstage etc.) — those don't
// get TTL caching, only dedup, so an explicit reload after a write
// still hits git.
const execFileAsync = promisify(execFile);

async function runGitAsync(
  cwd: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number; raw?: boolean } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: opts.timeout ?? 5000,
      encoding: 'utf-8',
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    });
    return opts.raw ? stdout : stdout.trim();
  } catch {
    return '';
  }
}

const GIT_STATUS_TTL_MS = 800;
const gitStatusCache = new Map<string, { result: GitStatus; ts: number }>();
const gitStatusInFlight = new Map<string, Promise<GitStatus>>();
const gitChangedFilesInFlight = new Map<string, Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]>>();

// Called by every IPC handler that mutates git state (stage / commit
// / push / merge / rebase / …). Drops the cached GitStatus so the
// next poll runs fresh — otherwise a save → commit → glance-at-bar
// flow could show 800 ms of pre-commit numbers.
function bustGitCache(cwd: string): void {
  gitStatusCache.delete(cwd);
}

export function setupIpcHandlers(window: BrowserWindow): void {
  mainWindow = window;

  mainWindow.on('closed', () => {
    isQuitting = true;
  });

  // Pending working→ready completion notifications. We hold these for
  // COMPLETION_CONFIRMATION_MS before firing the bell + OS notification, so
  // a quick working→ready→working bounce (e.g. Claude pausing between a
  // tool result and the next reasoning step) doesn't generate a false-
  // positive "task completed" ping. Cleared whenever the agent leaves the
  // 'ready' state during the window.
  const COMPLETION_CONFIRMATION_MS = 5000;
  const pendingCompletions: Map<string, ReturnType<typeof setTimeout>> = new Map();

  const clearPendingCompletion = (profileId: string): void => {
    const t = pendingCompletions.get(profileId);
    if (t) {
      clearTimeout(t);
      pendingCompletions.delete(profileId);
    }
  };

  // Resolve owner profile + focus state + startup-grace for a given PTY id.
  // Used by the notification firing path (extracted so it can run both
  // immediately for needs-input and after the confirmation delay for ready).
  const resolveNotificationContext = (
    profileId: string,
  ): {
    ownerProfile: Profile | undefined;
    parallelAgentId: string | null;
    titleSuffix: string;
    isFocusedOnThis: boolean;
    inStartupGrace: boolean;
  } => {
    const PARALLEL_NOTIF_GRACE_MS = 5000;
    if (profileId.startsWith('parallel:') && parallelManager) {
      const parallelAgentId = profileId.slice('parallel:'.length);
      const agent = parallelManager.get(parallelAgentId);
      if (agent) {
        return {
          ownerProfile: profiles.find((p) => p.id === agent.profileId),
          parallelAgentId,
          titleSuffix: ` · ${agent.taskId}`,
          isFocusedOnThis:
            mainWindow.isFocused() &&
            activeProfileId === agent.profileId &&
            activeParallelAgentId === parallelAgentId,
          inStartupGrace: Date.now() - agent.createdAt < PARALLEL_NOTIF_GRACE_MS,
        };
      }
      return { ownerProfile: undefined, parallelAgentId, titleSuffix: '', isFocusedOnThis: false, inStartupGrace: false };
    }
    return {
      ownerProfile: profiles.find((p) => p.id === profileId),
      parallelAgentId: null,
      titleSuffix: '',
      isFocusedOnThis:
        mainWindow.isFocused() &&
        profileId === activeProfileId &&
        activeParallelAgentId === null,
      inStartupGrace: false,
    };
  };

  const fireNotification = (
    profileId: string,
    kind: 'ready' | 'needs-input',
  ): void => {
    if (isQuitting) return;
    // User can turn off agent done/needs-input notifications (default on).
    if (loadSettings().notificationsEnabled === false) return;
    const ctx = resolveNotificationContext(profileId);
    if (!ctx.ownerProfile || ctx.isFocusedOnThis || ctx.inStartupGrace) return;

    const opts: Electron.NotificationConstructorOptions = {
      title: ctx.ownerProfile.name + ctx.titleSuffix,
      body: kind === 'ready' ? 'Task completed' : 'Needs your input',
    };
    if (ctx.ownerProfile.icon && fs.existsSync(ctx.ownerProfile.icon)) {
      opts.icon = ctx.ownerProfile.icon;
    }
    const notification = new Notification(opts);
    const targetProfileId = ctx.ownerProfile.id;
    const targetParallelId = ctx.parallelAgentId;
    notification.on('click', () => {
      if (mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      safeSend(IPC_CHANNELS.PROFILE_ACTIVATE_REQUEST, {
        profileId: targetProfileId,
        parallelAgentId: targetParallelId,
      });
    });
    notification.show();
  };

  statusDetector = new StatusDetector((profileId, status, previousStatus, _output, hasNewContent) => {
    // Cancel any pending completion confirmation as soon as the agent leaves
    // 'ready' — this is the primary defense against false-positive "done"
    // notifications when the agent briefly idles between turns.
    if (status !== 'ready') {
      clearPendingCompletion(profileId);
    }

    // Working→ready with new content is a CANDIDATE for completion. Send the
    // status update immediately (badge color stays accurate) but suppress the
    // bell trigger (hasNewContent=false in the renderer payload). The bell
    // fires later via PROFILE_COMPLETION_CONFIRMED if the agent stays ready
    // for COMPLETION_CONFIRMATION_MS.
    const isCompletionCandidate =
      status === 'ready' && previousStatus === 'working' && hasNewContent === true;

    safeSend(IPC_CHANNELS.PROFILE_STATUS_CHANGE, {
      profileId,
      status,
      hasNewContent: isCompletionCandidate ? false : hasNewContent,
    });

    // Parallel agent finish() trigger stays IMMEDIATE — it only fires when
    // the task md file says `status: done`, which the agent itself wrote.
    // Delaying it would just delay the worktree teardown / git push.
    if (profileId.startsWith('parallel:') && parallelManager) {
      const id = profileId.slice('parallel:'.length);
      const agent = parallelManager.get(id);
      if (agent && agent.phase !== 'completed' && agent.phase !== 'pushing') {
        if (status === 'working') {
          parallelManager.updatePhase(id, 'running');
        } else if (status === 'ready' && previousStatus === 'working') {
          if (parallelManager.isTaskDone(id)) {
            const ownerProfile = profiles.find((p) => p.id === agent.profileId);
            const autoPush = ownerProfile?.parallelAgentAutoPush === true;
            parallelManager.finish(id, autoPush).catch((): void => undefined);
          }
        }
      }
    }

    if (isQuitting) return;

    // needs-input is urgent — fire bell + notification immediately.
    if (
      status === 'needs-input' &&
      (previousStatus === 'working' || previousStatus === 'ready')
    ) {
      // Renderer already adds to hasUpdates on its own when status === 'needs-input'.
      fireNotification(profileId, 'needs-input');
      return;
    }

    // ready completion — schedule the delayed confirmation.
    if (isCompletionCandidate) {
      clearPendingCompletion(profileId);
      const t = setTimeout(() => {
        pendingCompletions.delete(profileId);
        // Tell the renderer the completion is real (lights the bell).
        safeSend(IPC_CHANNELS.PROFILE_COMPLETION_CONFIRMED, { profileId });
        // And fire the OS notification.
        fireNotification(profileId, 'ready');
      }, COMPLETION_CONFIRMATION_MS);
      pendingCompletions.set(profileId, t);
    }
  });

  // Process a coalesced batch of PTY output. Status detection, scrollback
  // accumulation, and flow-controlled IPC dispatch all run once per batch
  // instead of once per tiny chunk.
  processBatch = (profileId, data) => {
    // Skip status detection for shell and ordna PTYs.
    // Parallel agents use the status detector with their `parallel:<id>`
    // prefix so we can react to working→ready transitions for auto-push.
    if (!profileId.startsWith('shell:') && !profileId.startsWith('ordna:')) {
      // Skip during the post-resize quiet window — the data is a SIGWINCH
      // repaint, not the agent doing work. Status stays as-is (a genuinely
      // working agent keeps its state; the next real output re-evaluates).
      const quietUntil = resizeQuietUntil.get(profileId);
      if (!quietUntil || Date.now() >= quietUntil) {
        statusDetector.feedData(profileId, data);
      }
    }
    // Accumulate scrollback for shell terminals
    if (profileId.startsWith('shell:')) {
      let buf = scrollbackBuffers.get(profileId) || '';
      buf += data;
      if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
      scrollbackBuffers.set(profileId, buf);
    }

    // Flow control — buffer data if renderer is behind
    let flow = flowStates.get(profileId);
    if (!flow) {
      flow = { pending: 0, paused: false, buffer: [] };
      flowStates.set(profileId, flow);
    }
    if (flow.paused) {
      flow.buffer.push(data);
    } else {
      const bytes = ipcEncoder.encode(data);
      flow.pending += bytes.byteLength;
      safeSend(IPC_CHANNELS.TERMINAL_DATA, { profileId, data: bytes });
      if (flow.pending >= FLOW_HIGH_WATERMARK) {
        flow.paused = true;
      }
    }
  };

  ptyManager = new PtyManager(
    (profileId, data) => {
      queueData(profileId, data);
    },
    (profileId) => {
      // Flush any queued PTY output before announcing exit so the renderer
      // sees the final lines (e.g. error messages on crash) before "offline".
      flushCoalesced(profileId);
      clearCoalesced(profileId);

      if (profileId.startsWith('shell:')) {
        safeSend(IPC_CHANNELS.SHELL_TERMINAL_EXITED, { terminalId: profileId });
      } else if (profileId.startsWith('ordna:')) {
        const instanceKey = profileId.slice('ordna:'.length);
        if (ordnaManager) ordnaManager.handlePtyExit(instanceKey);
        safeSend(IPC_CHANNELS.SHELL_TERMINAL_EXITED, { terminalId: profileId });
        safeSend(IPC_CHANNELS.ORDNA_EXITED, { instanceKey });
      } else if (profileId.startsWith('parallel:')) {
        const id = profileId.slice('parallel:'.length);
        statusDetector.unregister(profileId);
        if (parallelManager) {
          // Tear down the worktree and emit exit notification
          parallelManager.destroy(id).catch((): void => undefined);
        }
      } else {
        statusDetector.unregister(profileId);
        safeSend(IPC_CHANNELS.PROFILE_STATUS_CHANGE, {
          profileId,
          status: 'offline',
        });
      }
    },
  );

  ordnaManager = new OrdnaManager(ptyManager);
  parallelManager = new ParallelAgentManager(ptyManager, statusDetector, {
    onChange: (a) => safeSend(IPC_CHANNELS.PARALLEL_AGENT_CHANGE, a),
    onExited: (a) => safeSend(IPC_CHANNELS.PARALLEL_AGENT_EXITED, a),
  });
  initOrdnaHookServer();

  ipcMain.handle(IPC_CHANNELS.PROFILES_LOAD, () => {
    profiles = loadProfiles();
    return profiles;
  });

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CREATE,
    (_, profileId: string, profile: Profile, cols?: number, rows?: number) => {
      // Resolve agent config from settings
      const settings = loadSettings();
      const agents = settings.agents || DEFAULT_AGENTS;
      const resolved = resolveAgent(profile, agents);

      // Build effective profile with resolved command/args, then drop any
      // resume flags whose required state directory doesn't exist in cwd.
      const effectiveProfile = applyAgentArgsGuards({
        ...profile,
        command: resolved.command,
        args: resolved.args,
      });

      statusDetector.register(profileId, effectiveProfile);
      ptyManager.create(profileId, effectiveProfile, cols, rows);
    },
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INPUT,
    (_, profileId: string, data: string) => {
      ptyManager.write(profileId, data);
      // Windows shells: ConPTY won't dispatch CTRL_C_EVENT to grandchild
      // python.exe (and other apps that only listen for the OS-level console
      // signal) from a raw `\x03` byte. Pair the byte with a real
      // GenerateConsoleCtrlEvent so Ctrl+C interrupts Python like it does on
      // macOS/Linux. Fires for:
      //   - `shell:*` PTYs (the split shell pane)
      //   - any "no-agent" profile whose PTY is just the user's shell
      //     (scratchpad profiles fall in here — they spawn powershell.exe
      //     directly and need the same treatment)
      // Skipped for agent CLIs (claude/codex/gemini/opencode) since they read
      // `\x03` directly as a TUI key and a doubled signal can over-cancel.
      if (
        data === '\x03'
        && process.platform === 'win32'
        && (profileId.startsWith('shell:') || ptyManager.isShell(profileId))
      ) {
        sendCtrlCToPty(ptyManager.getPid(profileId));
      }
      if (data === '\r' || data === '\n') {
        statusDetector.setWorking(profileId);
        if (profileId.startsWith('shell:')) {
          shellHadInput.add(profileId);
        }
      }
    },
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_RESIZE,
    (_, profileId: string, cols: number, rows: number) => {
      ptyManager.resize(profileId, cols, rows);
      // Mute status detection through the resulting repaint (see
      // resizeQuietUntil). Extends on every resize event during a drag.
      resizeQuietUntil.set(profileId, Date.now() + RESIZE_STATUS_QUIET_MS);
    },
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DESTROY, (_, profileId: string) => {
    flushCoalesced(profileId);
    clearCoalesced(profileId);
    // Capture pid before destroy() so we can drop stale Ctrl+C escalation
    // state — Windows reuses PIDs quickly and we don't want a long-dead
    // PTY's "second press = kill" state biasing the next process.
    const pid = ptyManager.getPid(profileId);
    ptyManager.destroy(profileId);
    clearCtrlCState(pid);
    statusDetector.unregister(profileId);
    flowStates.delete(profileId);
    resizeQuietUntil.delete(profileId);
  });

  // Flow control ACK — renderer reports bytes consumed
  ipcMain.on(IPC_CHANNELS.TERMINAL_ACK, (_, profileId: string, bytes: number) => {
    const flow = flowStates.get(profileId);
    if (!flow) return;
    flow.pending -= bytes;
    if (flow.pending < 0) flow.pending = 0;

    if (flow.paused && flow.pending < FLOW_LOW_WATERMARK) {
      flow.paused = false;
      const buffered = flow.buffer.join('');
      flow.buffer = [];
      if (buffered.length > 0) {
        const bytes = ipcEncoder.encode(buffered);
        flow.pending += bytes.byteLength;
        safeSend(IPC_CHANNELS.TERMINAL_DATA, { profileId, data: bytes });
        if (flow.pending >= FLOW_HIGH_WATERMARK) {
          flow.paused = true;
        }
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_SHOW_IN_FOLDER, (_, folderPath: string) => {
    shell.openPath(folderPath);
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_VSCODE, (_, folderPath: string) => {
    if (process.platform === 'darwin') {
      exec(`open -a "Visual Studio Code" "${folderPath}"`, (err) => {
        if (err) {
          console.error('Failed to open VS Code:', err.message);
        }
      });
    } else if (process.platform === 'win32') {
      exec(`code.cmd "${folderPath}"`, (err) => {
        if (err) {
          console.error('Failed to open VS Code:', err.message);
        }
      });
    } else {
      exec(`code "${folderPath}"`, (err) => {
        if (err) {
          console.error('Failed to open VS Code:', err.message);
        }
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_FORK, (_, folderPath: string) => {
    if (process.platform === 'darwin') {
      exec(`open -a Fork "${folderPath}"`, (err) => {
        if (err) {
          console.error('Failed to open Fork:', err.message);
        }
      });
    } else if (process.platform === 'win32') {
      exec(`Fork.exe "${folderPath}"`, (err) => {
        if (err) {
          console.error('Failed to open Fork:', err.message);
        }
      });
    } else {
      exec(`fork "${folderPath}"`, (err) => {
        if (err) {
          console.error('Failed to open Fork:', err.message);
        }
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_URL, (_, url: string) => {
    shell.openExternal(url);
  });

  // Embed the target webview's DevTools panel inside a second webview
  // (the "host"). Both are <webview> tags in the renderer; the renderer
  // hands us their webContents IDs after each fires `dom-ready`.
  // Electron renders the DevTools UI into whatever WebContents you pass
  // to `setDevToolsWebContents`, then `openDevTools({ mode: 'detach' })`
  // is needed to tell it to use the assigned host rather than spawning
  // a separate window.
  ipcMain.handle(IPC_CHANNELS.WEBVIEW_OPEN_DEVTOOLS, (_, targetId: number, _hostId: number): boolean => {
    const target = webContents.fromId(targetId);
    if (!target) return false;
    try {
      // Detach-mode DevTools — opens a separate, always-on-top child
      // window. Earlier attempt: embed via `setDevToolsWebContents`
      // into a second <webview> in the renderer. That approach is
      // unreliable on current Electron because the API requires the
      // host webContents to have done no navigation, but a renderer
      // <webview> tag with no `src` either fails to bootstrap or
      // fires `did-attach` before the connection can be established.
      // Detach mode is the documented, supported path that actually
      // shows the target's DOM/Console reliably.
      if (target.isDevToolsOpened()) {
        target.devToolsWebContents?.focus();
      } else {
        target.openDevTools({ mode: 'detach' });
      }
      return true;
    } catch (err) {
      console.error('[devtools] failed to open:', err);
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.WEBVIEW_CLOSE_DEVTOOLS, (_, targetId: number): boolean => {
    const target = webContents.fromId(targetId);
    if (!target) return false;
    try {
      if (target.isDevToolsOpened()) target.closeDevTools();
      return true;
    } catch {
      return false;
    }
  });

  // Track which webContents we've already wired so re-registers after
  // a navigation (renderer calls register on every dom-ready) don't
  // stack duplicate listeners. The Set entries are cleaned up when the
  // webContents is destroyed by the listener above.
  const contextMenuRegistered = new Set<number>();
  ipcMain.handle(IPC_CHANNELS.WEBVIEW_REGISTER_CONTEXT_MENU, (_, targetId: number): boolean => {
    if (contextMenuRegistered.has(targetId)) return true;
    const target = webContents.fromId(targetId);
    if (!target) return false;
    contextMenuRegistered.add(targetId);
    target.on('destroyed', () => contextMenuRegistered.delete(targetId));
    target.on('context-menu', (_evt, params) => {
      // Inspect lives in the renderer because we need to open the
      // embedded DevTools host before calling inspectElement —
      // otherwise Electron opens DevTools in a separate window.
      const sendInspect = () => {
        const host = target.hostWebContents ?? target;
        host.send(IPC_CHANNELS.WEBVIEW_INSPECT_REQUEST, {
          targetId,
          x: params.x,
          y: params.y,
        });
      };

      const menu = Menu.buildFromTemplate([
        {
          label: 'Back',
          enabled: target.canGoBack(),
          click: () => { try { target.goBack(); } catch { /* ignore */ } },
        },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => { try { target.reload(); } catch { /* ignore */ } },
        },
        { type: 'separator' },
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          enabled: params.editFlags.canCopy && !!params.selectionText,
          click: () => { try { target.copy(); } catch { /* ignore */ } },
        },
        {
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          enabled: params.editFlags.canPaste,
          click: () => { try { target.paste(); } catch { /* ignore */ } },
        },
        { type: 'separator' },
        {
          label: 'Inspect Element',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: sendInspect,
        },
      ]);
      const owner = BrowserWindow.fromWebContents(target.hostWebContents ?? target);
      if (owner) menu.popup({ window: owner, x: params.x, y: params.y });
      else menu.popup();
    });
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.WEBVIEW_INSPECT_AT, (_, targetId: number, x: number, y: number): boolean => {
    const target = webContents.fromId(targetId);
    if (!target) return false;
    try {
      target.inspectElement(x, y);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, (_, command: string, folderPath: string) => {
    const resolved = command.replace(/\{path\}/g, folderPath);
    exec(resolved, (err) => {
      if (err) {
        console.error('Failed to open external app:', err.message);
      }
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.SHELL_TERMINAL_CREATE,
    (_, terminalId: string, cwd: string) => {
      const defaultShell =
        os.platform() === 'win32'
          ? 'powershell.exe'
          : process.env.SHELL || '/bin/bash';
      const shellProfile: Profile = {
        id: terminalId,
        name: 'Shell',
        icon: '',
        workingDirectory: cwd,
        command: defaultShell,
        args: [],
      };
      // Reuse ptyManager but skip status detection
      ptyManager.create(terminalId, shellProfile);
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROFILES_SAVE, (_, updatedProfiles: Profile[]) => {
    saveProfiles(updatedProfiles);
    profiles = updatedProfiles;
  });

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      // `createDirectory` enables the "New Folder" button in the macOS
      // system dialog. Windows' folder picker has it built in, so the flag
      // is a no-op there. Linux behavior depends on the toolkit dialog.
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'ico'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Create a fresh temporary directory for a "scratchpad" agent profile.
  // Returns the absolute path. The OS cleans /tmp on reboot; we don't try
  // to delete it ourselves so the user can keep the contents if they want.
  ipcMain.handle(IPC_CHANNELS.DIALOG_CREATE_TEMP_DIR, (): string => {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vyb-agent-'));
  });

  ipcMain.handle(IPC_CHANNELS.FS_PATH_EXISTS, (_, p: string): boolean => {
    if (!p) return false;
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  ipcMain.on(IPC_CHANNELS.PROFILE_SET_ACTIVE, (_, profileId: string | null) => {
    activeProfileId = profileId;
  });

  ipcMain.on(IPC_CHANNELS.PARALLEL_AGENT_SET_SELECTED, (_, parallelAgentId: string | null) => {
    activeParallelAgentId = parallelAgentId;
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_STATUS_QUERY, () => {
    return statusDetector.getAll();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_LOAD, () => {
    return loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, (_, settings: AppSettings) => {
    saveSettings(settings);
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LOAD, () => {
    return loadLayout();
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_SAVE, (_, layout: SidebarLayout) => {
    saveLayout(layout);
  });

  ipcMain.handle(IPC_CHANNELS.BACKUP_EXPORT, async (): Promise<string | null> => {
    const archiver = require('archiver');
    const userDataPath = app.getPath('userData');

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Backup',
      defaultPath: `vyb-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;

    return new Promise((resolve) => {
      const output = fs.createWriteStream(result.filePath!);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve(result.filePath!));
      archive.on('error', (err: Error) => {
        console.error('Backup export failed:', err);
        resolve(null);
      });

      archive.pipe(output);

      // Add config files
      const files = ['profiles.json', 'settings.json', 'layout.json'];
      for (const f of files) {
        const p = path.join(userDataPath, f);
        if (fs.existsSync(p)) archive.file(p, { name: f });
      }

      // Add icons directory
      const iconsDir = path.join(userDataPath, 'icons');
      if (fs.existsSync(iconsDir)) {
        archive.directory(iconsDir, 'icons');
      }

      archive.finalize();
    });
  });

  ipcMain.handle(IPC_CHANNELS.BACKUP_IMPORT, async (): Promise<boolean> => {
    const AdmZip = require('adm-zip');
    const userDataPath = app.getPath('userData');

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Backup',
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return false;

    try {
      const zip = new AdmZip(result.filePaths[0]);
      const entries = zip.getEntries();

      for (const entry of entries) {
        if (entry.isDirectory) {
          const dirPath = path.join(userDataPath, entry.entryName);
          if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        } else {
          const targetPath = path.join(userDataPath, entry.entryName);
          const targetDir = path.dirname(targetPath);
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(targetPath, entry.getData());
        }
      }

      return true;
    } catch (err) {
      console.error('Backup import failed:', err);
      return false;
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.TRANSCRIBE_AUDIO,
    async (_, audioBase64: string, lang: string): Promise<string> => {
      const settings = loadSettings();

      // Use OpenAI Whisper API if key is available
      if (settings.openaiApiKey) {
        const audioBuffer = Buffer.from(audioBase64, 'base64');

        const boundary = `----formdata${Date.now()}`;
        const parts: Buffer[] = [];

        // model field
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
        ));

        // language field
        const langCode = lang.split('-')[0]; // 'en-US' -> 'en'
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${langCode}\r\n`,
        ));

        // audio file
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
        ));
        parts.push(audioBuffer);
        parts.push(Buffer.from('\r\n'));
        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${settings.openaiApiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Whisper API error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        return data.text || '';
      }

      // Fallback: use Gemini if no OpenAI key
      if (settings.geminiApiKey) {
        const model = 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': settings.geminiApiKey,
          },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: `Transcribe this audio to text. Language: ${lang}. Return only the transcribed text, nothing else.` },
                { inline_data: { mime_type: 'audio/webm', data: audioBase64 } },
              ],
            }],
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gemini API error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }

      throw new Error('No API key configured. Set an OpenAI or Gemini API key in Settings → Icons.');
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROFILE_MEMORY_LOAD, () => {
    return loadProfileMemory();
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_MEMORY_SAVE, (_, memory: ProfileMemoryMap) => {
    saveProfileMemory(memory);
  });

  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_LOAD, (_, profileId: string): string | null => {
    return loadScrollback(profileId);
  });

  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_SAVE, (_, profileId: string, data: string) => {
    saveScrollback(profileId, data);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async (_, cwd: string): Promise<GitStatus> => {
    // Cache + dedupe wrapper. A second call for the same cwd within
    // GIT_STATUS_TTL_MS reuses the previous result; a call while one
    // is in flight awaits the same promise.
    const cached = gitStatusCache.get(cwd);
    if (cached && Date.now() - cached.ts < GIT_STATUS_TTL_MS) return cached.result;
    const inFlight = gitStatusInFlight.get(cwd);
    if (inFlight) return inFlight;
    const promise = computeGitStatus(cwd).finally(() => {
      gitStatusInFlight.delete(cwd);
    });
    gitStatusInFlight.set(cwd, promise);
    const result = await promise;
    gitStatusCache.set(cwd, { result, ts: Date.now() });
    return result;
  });

  async function computeGitStatus(cwd: string): Promise<GitStatus> {
    const empty: GitStatus = {
      isGit: false, branch: '', modified: 0, staged: 0, untracked: 0,
      ahead: 0, behind: 0, stashes: 0, lastCommit: '', remoteUrl: '',
      mergeInProgress: false, mergeFromBranch: '',
      rebaseInProgress: false, rebaseHeadName: '', rebaseOnto: '',
      cherryPickInProgress: false, revertInProgress: false,
      conflictedFiles: [],
    };

    // Gate: only continue if we're inside a git work tree. This is
    // the one command that must come before everything else (no
    // point spawning seven more if it returns false).
    const isGitOut = await runGitAsync(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (isGitOut !== 'true') return empty;

    // Everything below is independent — fan out in parallel. Each
    // command's failure path returns '' so a single missing piece
    // (e.g. no upstream → no ahead/behind) doesn't poison the rest.
    const [
      branchPrimary, branchFallback,
      rawStatus,
      abStr,
      stashList,
      lastCommit,
      remoteUrlRaw,
      gitDir,
    ] = await Promise.all([
      runGitAsync(cwd, ['branch', '--show-current']),
      runGitAsync(cwd, ['rev-parse', '--short', 'HEAD']),
      runGitAsync(cwd, ['status', '--porcelain', '-z'], { raw: true }),
      runGitAsync(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
      runGitAsync(cwd, ['stash', 'list']),
      runGitAsync(cwd, ['log', '-1', '--pretty=format:%s']),
      runGitAsync(cwd, ['remote', 'get-url', 'origin']),
      runGitAsync(cwd, ['rev-parse', '--git-dir']),
    ]);

    const branch = branchPrimary || branchFallback;

    // Status porcelain parsing — same logic as before, just operating
    // on the awaited string.
    const statusLines = rawStatus.split('\0').filter((l) => l.length > 0);
    let modified = 0;
    let staged = 0;
    let untracked = 0;
    const conflictedFiles: string[] = [];
    for (let li = 0; li < statusLines.length; li++) {
      const line = statusLines[li];
      if (line.length < 3) continue;
      const x = line[0];
      const y = line[1];
      const filePath = line.slice(3);
      if (x === 'R' || y === 'R') li++;
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
        conflictedFiles.push(filePath);
      }
      if (x === '?') { untracked++; continue; }
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ' && y !== '?') modified++;
    }

    // Ahead/behind
    let ahead = 0;
    let behind = 0;
    if (abStr) {
      const parts = abStr.split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }

    // Stash count
    const stashes = stashList ? stashList.split('\n').filter(Boolean).length : 0;

    // Remote URL — convert SSH to HTTPS
    let remoteUrl = remoteUrlRaw;
    if (remoteUrl) {
      remoteUrl = remoteUrl
        .replace(/^git@([^:]+):/, 'https://$1/')
        .replace(/\.git$/, '');
      if (!remoteUrl.startsWith('http')) {
        remoteUrl = '';
      }
    }

    // Merge / rebase in progress?
    //   - Merge:  .git/MERGE_HEAD
    //   - Rebase: .git/rebase-apply/  (`git rebase` non-interactive) or
    //             .git/rebase-merge/  (`git rebase -i`)
    // For rebase we grab head-name (the branch being rebased) and `onto`
    // (the SHA we're rebasing onto, then resolve to a name if possible).
    let mergeInProgress = false;
    let mergeFromBranch = '';
    let rebaseInProgress = false;
    let rebaseHeadName = '';
    let rebaseOnto = '';
    let cherryPickInProgress = false;
    let revertInProgress = false;
    try {
      if (gitDir) {
        const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);

        if (fs.existsSync(path.join(absGitDir, 'MERGE_HEAD'))) {
          mergeInProgress = true;
          try {
            const msg = fs.readFileSync(path.join(absGitDir, 'MERGE_MSG'), 'utf-8');
            const m = msg.split('\n')[0]?.match(/Merge (?:branch|remote-tracking branch|commit) '([^']+)'/);
            if (m) mergeFromBranch = m[1];
          } catch { /* MERGE_MSG may not exist for some merge types */ }
        }

        for (const dir of ['rebase-apply', 'rebase-merge']) {
          const rebaseDir = path.join(absGitDir, dir);
          if (fs.existsSync(rebaseDir)) {
            rebaseInProgress = true;
            try {
              const headName = fs.readFileSync(path.join(rebaseDir, 'head-name'), 'utf-8').trim();
              rebaseHeadName = headName.replace(/^refs\/heads\//, '');
            } catch { /* missing on some rebase types */ }
            try {
              const ontoSha = fs.readFileSync(path.join(rebaseDir, 'onto'), 'utf-8').trim();
              // Resolve to a friendlier name if possible (e.g. "main"),
              // otherwise short SHA. This is the one sequential git
              // call we couldn't fan out earlier — it depends on the
              // onto SHA. Awaiting here adds maybe 20ms only when an
              // actual rebase is in progress.
              const named = await runGitAsync(cwd, ['name-rev', '--name-only', '--no-undefined', ontoSha]);
              rebaseOnto = named || ontoSha.slice(0, 8);
            } catch { /* leave empty */ }
            break;
          }
        }

        if (fs.existsSync(path.join(absGitDir, 'CHERRY_PICK_HEAD'))) cherryPickInProgress = true;
        if (fs.existsSync(path.join(absGitDir, 'REVERT_HEAD'))) revertInProgress = true;
      }
    } catch { /* not a real concern, leave defaults */ }

    return {
      isGit: true,
      branch, modified, staged, untracked, ahead, behind, stashes, lastCommit, remoteUrl,
      mergeInProgress, mergeFromBranch,
      rebaseInProgress, rebaseHeadName, rebaseOnto,
      cherryPickInProgress, revertInProgress,
      conflictedFiles,
    };
  }

  ipcMain.handle(IPC_CHANNELS.GIT_FETCH, (_, cwd: string): boolean => {
    try {
      execSync('git fetch --quiet', { cwd, timeout: 15000, encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CHANGED_FILES, async (_, cwd: string): Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]> => {
    // In-flight dedupe only — no TTL cache here. Stage / unstage /
    // commit IPCs invalidate the working state, and the renderer
    // calls this handler immediately after each, expecting fresh
    // data. A TTL would risk staleness for those flows.
    const existing = gitChangedFilesInFlight.get(cwd);
    if (existing) return existing;
    const promise = computeChangedFiles(cwd).finally(() => {
      gitChangedFilesInFlight.delete(cwd);
    });
    gitChangedFilesInFlight.set(cwd, promise);
    return promise;
  });

  async function computeChangedFiles(cwd: string): Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]> {
    // The three git commands we need are independent — fan out.
    // `git status --porcelain=v1 -z` is RAW (no trim) because the
    // first column is significant whitespace (a leading space
    // means "not staged"); trimming would mis-classify entries.
    const [rawZ, unstagedNumstat, stagedNumstat] = await Promise.all([
      runGitAsync(cwd, ['status', '--porcelain=v1', '-z'], { raw: true }),
      runGitAsync(cwd, ['diff', '--numstat']),
      runGitAsync(cwd, ['diff', '--cached', '--numstat']),
    ]);

    const fileMap = new Map<string, { status: string; staged: boolean }>();
    const setFromStatus = (x: string, y: string, filePath: string) => {
      if (!filePath) return;
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
        // Unmerged (conflicted) — checked first so UU/AA/DD aren't
        // mislabelled as modified/added/deleted.
        fileMap.set(filePath, { status: 'conflicted', staged: false });
      } else if (x === '?') {
        fileMap.set(filePath, { status: 'untracked', staged: false });
      } else if (x === 'A' || y === 'A') {
        fileMap.set(filePath, { status: 'added', staged: x !== ' ' });
      } else if (x === 'D' || y === 'D') {
        fileMap.set(filePath, { status: 'deleted', staged: x !== ' ' });
      } else if (x === 'R' || y === 'R') {
        fileMap.set(filePath, { status: 'renamed', staged: x !== ' ' });
      } else {
        fileMap.set(filePath, { status: 'modified', staged: x !== ' ' });
      }
    };

    const zRecords = rawZ.split('\0');
    for (let i = 0; i < zRecords.length; i++) {
      const rec = zRecords[i];
      if (!rec || rec.length < 3) continue;
      const x = rec[0];
      const y = rec[1];
      let pathStart = 2;
      while (pathStart < rec.length && rec[pathStart] === ' ') pathStart++;
      const filePath = rec.slice(pathStart);
      if (x === 'R' || y === 'R') i++;
      setFromStatus(x, y, filePath);
    }

    if (fileMap.size === 0) {
      // Fallback: -z gave us nothing despite a possibly-populated LF
      // output. Make the extra call here (only when needed) so the
      // hot path stays at 3 parallel commands instead of 4.
      const lfRaw = await runGitAsync(cwd, ['status', '--porcelain=v1'], { raw: true });
      const lfLines = lfRaw.replace(/\r?\n$/, '').split('\n').filter((l) => l.length > 0);
      for (const line of lfLines) {
        if (line.length < 3) continue;
        const x = line[0];
        const y = line[1];
        let pathStart = 2;
        while (pathStart < line.length && line[pathStart] === ' ') pathStart++;
        const filePath = line.slice(pathStart).replace(/^"(.*)"$/, '$1');
        setFromStatus(x, y, filePath);
      }
    }

    const counts = new Map<string, { added: number; deleted: number }>();
    const parseNumstat = (output: string) => {
      for (const line of output.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
        const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
        const filePath = parts[2].replace(/^"(.*)"$/, '$1');
        const existing = counts.get(filePath) || { added: 0, deleted: 0 };
        counts.set(filePath, {
          added: existing.added + added,
          deleted: existing.deleted + deleted,
        });
      }
    };
    parseNumstat(unstagedNumstat);
    parseNumstat(stagedNumstat);

    // Expand untracked directories (git status reports them as a single
     // entry with trailing slash) into their individual files so each shows
     // up as its own row with a real diff.
    const walkDir = (relDir: string, out: string[]): void => {
      const absDir = path.isAbsolute(relDir) ? relDir : path.join(cwd, relDir);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = path.join(relDir, e.name);
        if (e.isDirectory()) walkDir(childRel, out);
        else out.push(childRel);
      }
    };

    // Build result
    const result: { path: string; added: number; deleted: number; status: string; staged: boolean }[] = [];
    for (const [filePath, info] of fileMap) {
      const c = counts.get(filePath) || { added: 0, deleted: 0 };

      // Untracked directory — expand into individual files
      if (info.status === 'untracked' && filePath.endsWith('/')) {
        const expanded: string[] = [];
        walkDir(filePath.replace(/\/$/, ''), expanded);
        for (const f of expanded) {
          let added = 0;
          try {
            const absF = path.isAbsolute(f) ? f : path.join(cwd, f);
            const content = fs.readFileSync(absF, 'utf-8');
            added = content.split('\n').length;
          } catch { /* binary */ }
          result.push({ path: f, added, deleted: 0, status: 'untracked', staged: false });
        }
        continue;
      }

      let added = c.added;
      const deleted = c.deleted;
      if (info.status === 'untracked') {
        try {
          const absPath = filePath.startsWith('/') ? filePath : path.join(cwd, filePath);
          const content = fs.readFileSync(absPath, 'utf-8');
          added = content.split('\n').length;
        } catch { /* binary or unreadable */ }
      }
      result.push({ path: filePath, added, deleted, status: info.status, staged: info.staged });
    }
    // Sort: staged first, then alphabetical
    result.sort((a, b) => {
      if (a.staged !== b.staged) return a.staged ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return result;
  }

  // Compare two refs: surface every file that changed between them, plus
  // per-file diffs on demand. Powers the "Compare with…" panel (T-028).
  //
  // `threeDot` toggles the semantics:
  //   false (default) → `git diff a..b` = "every difference, even commits
  //          that aren't on b's branch"
  //   true  → `git diff a...b` = "what would land on a if you merged b
  //          into a" (changes since the merge-base)
  // We mirror that exactly using git's own range syntax.
  ipcMain.handle(IPC_CHANNELS.GIT_COMPARE_FILES, (_, cwd: string, a: string, b: string, threeDot?: boolean): { path: string; added: number; deleted: number; status: string; staged: boolean }[] => {
    if (!cwd || !a || !b) return [];
    const sep = threeDot ? '...' : '..';
    const range = `${a}${sep}${b}`;
    // --numstat for +/- counts; --name-status for the A/M/D/R letter.
    // Two passes so we keep the existing GitChangedFile shape verbatim.
    let numstat = '';
    let namestat = '';
    try {
      numstat = execFileSync('git', ['diff', '--numstat', '-z', range], { cwd, timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch { /* range invalid / unknown ref — empty list is the right answer */ }
    try {
      namestat = execFileSync('git', ['diff', '--name-status', '-z', range], { cwd, timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch { /* ditto */ }
    // Parse --numstat -z: each record is "added\tdeleted\tpath\0". For
    // renames the path is "oldPath\0newPath" so the record spans an
    // extra NUL — handled below.
    const stats = new Map<string, { added: number; deleted: number }>();
    {
      const tokens = numstat.split('\0');
      let i = 0;
      while (i < tokens.length) {
        const t = tokens[i];
        if (!t) { i++; continue; }
        // Each line has "a\td\tpath" — split on tab.
        const tabIdx = t.indexOf('\t');
        if (tabIdx === -1) { i++; continue; }
        const tab2 = t.indexOf('\t', tabIdx + 1);
        if (tab2 === -1) { i++; continue; }
        const aStr = t.slice(0, tabIdx);
        const dStr = t.slice(tabIdx + 1, tab2);
        let pathPart = t.slice(tab2 + 1);
        // Binary files report "-\t-\t<path>" — count as 0/0.
        const addedNum = aStr === '-' ? 0 : parseInt(aStr, 10) || 0;
        const deletedNum = dStr === '-' ? 0 : parseInt(dStr, 10) || 0;
        // Renames: numstat emits an empty path then the old name then the
        // new name (in NUL form). Heuristic: if pathPart is empty, the
        // next two records are old/new — we keep the new name.
        if (!pathPart && i + 2 < tokens.length) {
          i++; // skip old name
          pathPart = tokens[i + 1] ?? '';
        }
        if (pathPart) stats.set(pathPart, { added: addedNum, deleted: deletedNum });
        i++;
      }
    }
    // Parse --name-status -z: tokens like "M", path, "M", path, ...
    // Renames use "R<score>", old, new.
    const out: { path: string; added: number; deleted: number; status: string; staged: boolean }[] = [];
    {
      const tokens = namestat.split('\0').filter((t) => t.length > 0);
      let i = 0;
      while (i < tokens.length) {
        const code = tokens[i];
        if (!code) { i++; continue; }
        const letter = code[0];
        if (letter === 'R' || letter === 'C') {
          // Renames / copies use two paths
          const newPath = tokens[i + 2];
          if (newPath) {
            const s = stats.get(newPath) ?? { added: 0, deleted: 0 };
            out.push({ path: newPath, added: s.added, deleted: s.deleted, status: letter === 'R' ? 'renamed' : 'added', staged: false });
          }
          i += 3;
        } else {
          const filePath = tokens[i + 1];
          if (filePath) {
            const s = stats.get(filePath) ?? { added: 0, deleted: 0 };
            const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
            out.push({ path: filePath, added: s.added, deleted: s.deleted, status, staged: false });
          }
          i += 2;
        }
      }
    }
    return out;
  });

  // Per-file diff for the compare view. Same range semantics as
  // GIT_COMPARE_FILES — mirrors `git diff <range> -- <path>` directly,
  // with no synthesised "all-lines-added" fallback (compare is always
  // between two real refs, so an empty diff just means the file is the
  // same on both sides).
  ipcMain.handle(IPC_CHANNELS.GIT_COMPARE_FILE_DIFF, (_, cwd: string, a: string, b: string, filePath: string, threeDot?: boolean): string => {
    if (!cwd || !a || !b || !filePath) return '';
    const sep = threeDot ? '...' : '..';
    const range = `${a}${sep}${b}`;
    try {
      return execFileSync('git', ['diff', range, '--', filePath], {
        cwd, timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  });

  // Read the base / ours / theirs version of a conflicted file from the
  // index. Stage 1 = common ancestor (base), 2 = HEAD (ours), 3 = MERGE_HEAD
  // (theirs). Powers the conflict-resolution UI (T-025); returns '' if
  // the stage doesn't exist for this path (e.g. add/add conflict has no
  // base).
  ipcMain.handle(IPC_CHANNELS.GIT_SHOW_STAGE, (_, cwd: string, filePath: string, stage: 1 | 2 | 3): string => {
    if (!cwd || !filePath || (stage !== 1 && stage !== 2 && stage !== 3)) return '';
    try {
      return execFileSync('git', ['show', `:${stage}:${filePath}`], {
        cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  });

  // Hunk / line-level staging (T-023). Renderer builds a unified-diff
  // string that includes only the hunks (or hunk subsets) the user
  // picked, then we stream it through `git apply --cached`. `reverse`
  // flips the direction so unstage-selection works against the staged
  // diff. `--recount` lets git fix off-by-one line counts that the
  // renderer's builder might produce when boundary lines drop;
  // `--whitespace=nowarn` keeps the apply quiet on CRLF repos.
  // File history (T-026). `--follow` chases renames; `-z`-style NUL
  // separation isn't supported by `git log --pretty`, so we use the
  // same record-separator trick as GIT_LOG. Path is passed as a strict
  // positional after `--` so funny filenames can't be re-interpreted
  // as flags.
  ipcMain.handle(IPC_CHANNELS.GIT_FILE_LOG, (_, cwd: string, filePath: string, limit?: number): GitCommit[] => {
    if (!cwd || !filePath) return [];
    const cap = Math.max(1, Math.min(5000, (limit ?? 500) | 0 || 500));
    try {
      const fmt = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%x1e';
      const out = execFileSync('git', [
        'log',
        '--follow',
        `--max-count=${cap}`,
        `--pretty=format:${fmt}`,
        '--', filePath,
      ], { cwd, timeout: 20000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
      const commits: GitCommit[] = [];
      for (const record of out.split('\x1e')) {
        const trimmed = record.replace(/^\n+/, '');
        if (!trimmed) continue;
        const fields = trimmed.split('\x00');
        if (fields.length < 6) continue;
        const [sha, parents, author, email, date, subject] = fields;
        commits.push({
          sha, parents: parents ? parents.split(' ').filter(Boolean) : [], author, email, date, subject,
        });
      }
      return commits;
    } catch {
      return [];
    }
  });

  // Diff of a single file at a single commit (T-026). We use the
  // commit's first parent to anchor the diff. For root commits (no
  // parent) we diff against the empty tree so additions render
  // correctly. `-M` enables rename detection so the diff still works
  // when --follow gave us a renamed history.
  ipcMain.handle(IPC_CHANNELS.GIT_FILE_LOG_DIFF, (_, cwd: string, sha: string, filePath: string): string => {
    if (!cwd || !sha || !filePath) return '';
    try {
      const parent = (() => {
        try {
          return execFileSync('git', ['rev-parse', `${sha}^`], { cwd, timeout: 5000, encoding: 'utf-8' }).trim();
        } catch {
          return '';
        }
      })();
      const base = parent || '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // empty tree
      return execFileSync('git', ['diff', '-M', `${base}`, sha, '--', filePath], {
        cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  });

  // Per-profile commit-signing toggle (T-042). Reads / writes
  // `commit.gpgsign` in the repo's local config. The value is also
  // surfaced as a small badge next to the commit button so the user
  // can see at a glance whether their next commit will be signed.
  ipcMain.handle(IPC_CHANNELS.GIT_GET_SIGN_COMMITS, (_, cwd: string): boolean => {
    if (!cwd) return false;
    try {
      const out = execFileSync('git', ['config', '--local', '--get', 'commit.gpgsign'], {
        cwd, timeout: 3000, encoding: 'utf-8',
      }).trim().toLowerCase();
      return out === 'true' || out === '1' || out === 'yes';
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_SET_SIGN_COMMITS, (_, cwd: string, enabled: boolean): { ok: boolean; error?: string } => {
    if (!cwd) return { ok: false, error: 'no cwd' };
    try {
      if (enabled) {
        execFileSync('git', ['config', '--local', 'commit.gpgsign', 'true'], { cwd, timeout: 3000 });
      } else {
        // `--unset` errors if the key is missing; ignore that path.
        try {
          execFileSync('git', ['config', '--local', '--unset', 'commit.gpgsign'], { cwd, timeout: 3000 });
        } catch {
          execFileSync('git', ['config', '--local', 'commit.gpgsign', 'false'], { cwd, timeout: 3000 });
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'failed' };
    }
  });

  // Per-line blame (T-027). Parses `git blame --line-porcelain` —
  // every line is preceded by a header block of "<key> <value>" lines
  // (author, author-time, summary, etc.), then a content line prefixed
  // with a tab. Headers are only re-emitted in full the first time a
  // SHA is seen in the output; subsequent occurrences carry just the
  // SHA + ranges, so we cache per SHA as we go.
  ipcMain.handle(IPC_CHANNELS.GIT_BLAME_FILE, (_, cwd: string, filePath: string): import('../shared/types').GitBlameLine[] => {
    if (!cwd || !filePath) return [];
    try {
      const out = execFileSync('git', ['blame', '--line-porcelain', '--', filePath], {
        cwd, timeout: 30000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
      });
      const lines = out.split('\n');
      const cache = new Map<string, { author: string; authorTime: string; summary: string }>();
      const result: import('../shared/types').GitBlameLine[] = [];
      let i = 0;
      while (i < lines.length) {
        const headerLine = lines[i];
        if (!headerLine) { i++; continue; }
        // Header: "<sha> <orig-line> <final-line> [num-lines]"
        const headerMatch = headerLine.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/);
        if (!headerMatch) { i++; continue; }
        const sha = headerMatch[1];
        const finalLine = parseInt(headerMatch[2], 10);
        let author = cache.get(sha)?.author ?? '';
        let authorTime = cache.get(sha)?.authorTime ?? '';
        let summary = cache.get(sha)?.summary ?? '';
        let authorTz = '';
        i++;
        while (i < lines.length && !lines[i].startsWith('\t')) {
          const headerKv = lines[i];
          if (headerKv.startsWith('author ')) author = headerKv.slice(7);
          else if (headerKv.startsWith('author-time ')) authorTime = headerKv.slice(12);
          else if (headerKv.startsWith('author-tz ')) authorTz = headerKv.slice(10);
          else if (headerKv.startsWith('summary ')) summary = headerKv.slice(8);
          i++;
        }
        cache.set(sha, { author, authorTime, summary });
        // Skip the tab-prefixed content line itself.
        if (i < lines.length && lines[i].startsWith('\t')) i++;
        // Convert author-time (epoch seconds) + tz to ISO.
        let iso = '';
        if (authorTime) {
          const epoch = parseInt(authorTime, 10);
          if (!Number.isNaN(epoch)) iso = new Date(epoch * 1000).toISOString();
        }
        result.push({
          lineNumber: finalLine,
          sha,
          shortSha: sha.slice(0, 7),
          author,
          authorTime: iso,
          summary,
        });
        // Suppress unused-var warning; tz is captured for future use
        // but not surfaced yet.
        void authorTz;
      }
      return result;
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_APPLY_PATCH, async (_, cwd: string, patch: string, opts?: { reverse?: boolean }): Promise<{ ok: boolean; error?: string }> => {
    if (!cwd || !patch) return { ok: false, error: 'Empty patch' };
    return await new Promise((resolve) => {
      const args = ['apply', '--cached', '--whitespace=nowarn', '--recount'];
      if (opts?.reverse) args.push('--reverse');
      args.push('-');
      const child = spawn('git', args, { cwd });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: stderr.trim() || `git apply exited with code ${code}` });
      });
      child.stdin.end(patch);
    });
  });

  // Returns the file's contents at HEAD, or null if it isn't tracked
  // at HEAD (a brand-new file has no baseline). Drives the unified
  // diff view in the file editor — CodeMirror's `unifiedMergeView`
  // needs the original text, not a unified-diff blob.
  ipcMain.handle(IPC_CHANNELS.GIT_FILE_AT_HEAD, (_, cwd: string, filePath: string): string | null => {
    const escaped = filePath.replace(/"/g, '\\"');
    try {
      return execSync(`git show HEAD:"${escaped}"`, {
        cwd,
        timeout: 5000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_FILE_DIFF, (_, cwd: string, filePath: string, staged?: boolean): string => {
    const run = (cmd: string): string => {
      try {
        return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        return '';
      }
    };
    const escaped = filePath.replace(/"/g, '\\"');
    // staged=true → index vs HEAD;  staged=false → working tree vs index;
    // staged=undefined → combined (legacy callers).
    let diff: string;
    if (staged === true) {
      diff = run(`git diff --cached -- "${escaped}"`);
    } else if (staged === false) {
      diff = run(`git diff -- "${escaped}"`);
    } else {
      diff = run(`git diff HEAD -- "${escaped}"`);
    }

    // Empty diff: only fall back to a synthetic "all lines added" view if
    // the file is genuinely untracked (not yet known to git). For tracked
    // files an empty diff means "no changes on this side" — synthesising
    // +lines from disk would produce a misleading view (and was the
    // source of an earlier bug where a wrong path showed `(unreadable:
    // ENOENT…)` instead of just an empty diff).
    if (!diff) {
      const trackedCheck = (() => {
        try {
          execSync(`git ls-files --error-unmatch -- "${escaped}"`, {
            cwd, timeout: 5000, encoding: 'utf-8',
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (trackedCheck) {
        return '';
      }
      const absPath = filePath.startsWith('/') ? filePath : path.join(cwd, filePath);
      try {
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          // Shouldn't happen now that GIT_CHANGED_FILES expands dirs, but
          // handle defensively.
          return `@@ -0,0 +1,1 @@\n+(directory — no diff to show)`;
        }
        const content = fs.readFileSync(absPath, 'utf-8');
        const lines = content.split('\n');
        return `+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join('\n');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `@@ -0,0 +1,1 @@\n+(unreadable: ${msg})`;
      }
    }

    // Binary diff: git outputs "Binary files a/foo and b/foo differ" with no
    // +/- lines, which the renderer's parseDiff filters out, leaving an empty
    // view. Surface it as a single context line so something is shown.
    if (/^Binary files .* differ$/m.test(diff) && !/^[+-]/m.test(diff)) {
      return `@@ -0,0 +1,1 @@\n (binary file — diff not shown)`;
    }

    // Header-only diff (mode change, rename without content change, etc.) —
    // no @@ hunk to parse, so the renderer would show "No diff available".
    // Surface the header lines as context.
    if (!/\n@@ /.test(diff)) {
      const headerLines = diff
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('diff --git') && !l.startsWith('index '));
      if (headerLines.length > 0) {
        return `@@ -0,0 +1,${headerLines.length} @@\n` + headerLines.map((l) => ` ${l}`).join('\n');
      }
    }

    return diff;
  });

  // Stage a file (working-tree → index). Works for new, modified, and
  // deleted files. Path goes through argv so spaces/specials don't need
  // shell quoting. The trailing `--` ensures we never confuse a path that
  // looks like a flag with an option.
  ipcMain.handle(IPC_CHANNELS.GIT_STAGE, (_, cwd: string, filePath: string): boolean => {
    if (!filePath) return false;
    try {
      execFileSync('git', ['add', '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
      bustGitCache(cwd);
      return true;
    } catch {
      return false;
    }
  });

  // Unstage a file (index → working tree, leaves the working copy
  // untouched). Tries `git restore --staged` first (modern, ≥ 2.23) and
  // falls back to `git reset HEAD --` for older binaries.
  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE, (_, cwd: string, filePath: string): boolean => {
    if (!filePath) return false;
    try {
      try {
        execFileSync('git', ['restore', '--staged', '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
      } catch {
        execFileSync('git', ['reset', 'HEAD', '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
      }
      bustGitCache(cwd);
      return true;
    } catch {
      return false;
    }
  });

  // Discard a single file's working-tree changes (and its staged copy if
  // any). Behaviour per status:
  //   untracked → delete from disk (it isn't in git, so `git restore`
  //               can't help; we just `fs.unlinkSync` it).
  //   anything else → `git restore --staged --worktree -- <path>` which
  //               drops both the index and working-tree copies, returning
  //               the file to its HEAD state. Falls back to the older
  //               `git checkout HEAD -- <path>` + `git reset HEAD -- <path>`
  //               combo when `git restore` isn't available.
  // Always destructive — caller is expected to have confirmed with the user.
  ipcMain.handle(
    IPC_CHANNELS.GIT_DISCARD_FILE,
    (_, cwd: string, filePath: string, untracked: boolean): boolean => {
      if (!filePath) return false;
      if (untracked) {
        try {
          fs.unlinkSync(path.join(cwd, filePath));
          return true;
        } catch {
          return false;
        }
      }
      try {
        try {
          execFileSync(
            'git',
            ['restore', '--staged', '--worktree', '--', filePath],
            { cwd, timeout: 10000, encoding: 'utf-8' },
          );
        } catch {
          // Fallback for older git: unstage, then checkout the HEAD copy.
          execFileSync('git', ['reset', 'HEAD', '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
          execFileSync('git', ['checkout', 'HEAD', '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
        }
        return true;
      } catch {
        return false;
      }
    },
  );

  // Commit whatever's currently staged. Subject + optional body; both
  // travel as separate `-m` flags so git renders the body as the
  // standard "blank line then paragraph" message.
  ipcMain.handle(
    IPC_CHANNELS.GIT_COMMIT,
    (_, cwd: string, subject: string, description: string): GitCommitResult => {
      const subj = (subject ?? '').trim();
      if (!subj) return { ok: false, message: 'Commit subject is required.' };
      const body = (description ?? '').trim();
      const args = ['commit', '-m', subj];
      if (body) args.push('-m', body);
      try {
        execFileSync('git', args, { cwd, timeout: 30000, encoding: 'utf-8' });
        bustGitCache(cwd);
        return { ok: true };
      } catch (err) {
        // execFileSync's error carries stdout/stderr on some platforms —
        // surface whichever we can find so the user sees the real reason
        // (empty staging area, hook rejection, signing failure, etc.).
        const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
        const stderr = e.stderr ? e.stderr.toString().trim() : '';
        const stdout = e.stdout ? e.stdout.toString().trim() : '';
        return { ok: false, message: stderr || stdout || e.message || 'commit failed' };
      }
    },
  );

  // HEAD inspection — surfaces the most recent commit's subject + body so
  // the Reword / Amend dialogs can pre-fill, and reports whether HEAD has
  // been pushed to an upstream (drives the "rewrites public history?"
  // warning).
  ipcMain.handle(
    IPC_CHANNELS.GIT_HEAD_INFO,
    (_, cwd: string): {
      ok: boolean;
      sha?: string;
      subject?: string;
      body?: string;
      pushed?: boolean;
      branch?: string;
      message?: string;
    } => {
      try {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 10000, encoding: 'utf-8' }).trim();
        const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd, timeout: 10000, encoding: 'utf-8' }).trim();
        const body = execFileSync('git', ['log', '-1', '--pretty=%b'], { cwd, timeout: 10000, encoding: 'utf-8' }).trim();
        // Branch name (or empty on detached HEAD)
        let branch = '';
        try {
          branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 10000, encoding: 'utf-8' }).trim();
          if (branch === 'HEAD') branch = '';
        } catch { /* detached */ }
        // Has HEAD been pushed anywhere? Check if any remote-tracking ref
        // contains this commit. Avoids the "rewrites public history" trap.
        let pushed = false;
        try {
          const out = execFileSync('git', ['branch', '-r', '--contains', sha], { cwd, timeout: 10000, encoding: 'utf-8' });
          pushed = out.trim().length > 0;
        } catch { /* no remote / detached / unknown — assume not pushed */ }
        return { ok: true, sha, subject, body, pushed, branch };
      } catch (err) {
        const e = err as { message?: string; stderr?: string | Buffer };
        const stderr = e.stderr ? e.stderr.toString().trim() : '';
        return { ok: false, message: stderr || e.message || 'head info failed' };
      }
    },
  );

  // Amend the last commit — folds anything currently staged into HEAD and
  // (optionally) replaces the message. When `keepMessage` is true we use
  // `--no-edit` so the existing message survives even if nothing is
  // staged (rare; mostly users will stage first).
  ipcMain.handle(
    IPC_CHANNELS.GIT_AMEND_COMMIT,
    (_, cwd: string, subject: string | null, description: string | null): GitCommitResult => {
      const args = ['commit', '--amend'];
      const subj = subject == null ? null : subject.trim();
      const body = description == null ? null : description.trim();
      if (subj === null) {
        // Keep the existing message verbatim.
        args.push('--no-edit');
      } else {
        if (!subj) return { ok: false, message: 'Commit subject is required.' };
        args.push('-m', subj);
        if (body) args.push('-m', body);
      }
      try {
        execFileSync('git', args, { cwd, timeout: 30000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
        const stderr = e.stderr ? e.stderr.toString().trim() : '';
        const stdout = e.stdout ? e.stdout.toString().trim() : '';
        return { ok: false, message: stderr || stdout || e.message || 'amend failed' };
      }
    },
  );

  // Reword HEAD — same as amend with no staged changes, but stages
  // nothing implicitly. Same plumbing, separate channel for clarity at
  // the call site (and so we can refuse to reword merge commits later
  // without affecting the amend path).
  ipcMain.handle(
    IPC_CHANNELS.GIT_REWORD_HEAD,
    (_, cwd: string, subject: string, description: string): GitCommitResult => {
      const subj = (subject ?? '').trim();
      if (!subj) return { ok: false, message: 'Commit subject is required.' };
      const body = (description ?? '').trim();
      const args = ['commit', '--amend', '--only', '-m', subj];
      if (body) args.push('-m', body);
      try {
        execFileSync('git', args, { cwd, timeout: 30000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
        const stderr = e.stderr ? e.stderr.toString().trim() : '';
        const stdout = e.stdout ? e.stdout.toString().trim() : '';
        return { ok: false, message: stderr || stdout || e.message || 'reword failed' };
      }
    },
  );

  // Push the current branch to its upstream. If the branch has no upstream
  // configured yet (a fresh local branch), retry with `-u origin <branch>`
  // to publish it — same convenience git itself prints in its hint, just
  // applied automatically.
  ipcMain.handle(IPC_CHANNELS.GIT_PUSH, (_, cwd: string, tagMode?: 'off' | 'reachable' | 'all'): GitOpResult => {
    const errMsg = (err: unknown, fallback: string): string => {
      const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      const stdout = e.stdout ? e.stdout.toString().trim() : '';
      return stderr || stdout || e.message || fallback;
    };
    // Tag mode: 'reachable' = annotated tags reachable from pushed
    // commits (`--follow-tags`); 'all' = every local tag (`--tags`);
    // off / undefined = no tags. Note that `--tags` + a branch push
    // implies refspec-based "push only what's requested" — the order
    // below appends after `push` itself so it applies to both the
    // default push and the auto-publish retry below.
    const tagFlag = tagMode === 'all' ? ['--tags']
      : tagMode === 'reachable' ? ['--follow-tags']
      : [];
    try {
      execFileSync('git', ['push', ...tagFlag], { cwd, timeout: 60000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      const e = err as { stderr?: string | Buffer };
      const stderr = e.stderr ? e.stderr.toString() : '';
      // Detect "no upstream" so we can offer to publish the branch.
      if (/has no upstream branch|no upstream configured|set-upstream/i.test(stderr)) {
        let branch = '';
        try {
          branch = execSync('git symbolic-ref --short HEAD', {
            cwd, timeout: 5000, encoding: 'utf-8',
          }).trim();
        } catch { /* detached HEAD or worse */ }
        if (!branch) {
          return { ok: false, message: 'Detached HEAD — checkout a branch before pushing.' };
        }
        try {
          execFileSync('git', ['push', '-u', ...tagFlag, 'origin', branch], {
            cwd, timeout: 60000, encoding: 'utf-8',
          });
          return { ok: true, publishedUpstream: true };
        } catch (err2) {
          return { ok: false, message: errMsg(err2, 'push failed') };
        }
      }
      return { ok: false, message: errMsg(err, 'push failed') };
    }
  });

  // Force-push the current branch with --force-with-lease. We always
  // fetch first so the lease ref is populated — without that, git
  // silently falls back to a plain --force which is exactly the
  // unsafety we're trying to avoid. If the lease fails (someone else
  // pushed in the meantime) we surface git's own rejection message.
  ipcMain.handle(IPC_CHANNELS.GIT_PUSH_FORCE_LEASE, (_, cwd: string): GitOpResult => {
    const errMsg = (err: unknown, fallback: string): string => {
      const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      const stdout = e.stdout ? e.stdout.toString().trim() : '';
      return stderr || stdout || e.message || fallback;
    };
    // Resolve the current branch first — force-push needs a real branch.
    let branch = '';
    try {
      branch = execSync('git symbolic-ref --short HEAD', { cwd, timeout: 5000, encoding: 'utf-8' }).trim();
    } catch { /* detached */ }
    if (!branch) {
      return { ok: false, message: 'Detached HEAD — checkout a branch before force-pushing.' };
    }
    // Fetch first so --force-with-lease has a live remote-tracking ref
    // to compare against (otherwise --force-with-lease degrades to a
    // plain --force, defeating the safety net).
    try {
      execFileSync('git', ['fetch', '--quiet'], { cwd, timeout: 30000, encoding: 'utf-8' });
    } catch {
      // Fetch failure isn't fatal — push might still work over the
      // existing remote-tracking refs. Surface push errors instead.
    }
    try {
      execFileSync('git', ['push', '--force-with-lease'], { cwd, timeout: 60000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: errMsg(err, 'force-push failed') };
    }
  });

  // Rebase variant of pull. Explicit so the call site can pick per-click
  // without writing to user-level git config. Behaviour and error
  // surface match the plain pull path — conflicts land in the same
  // rebase-in-progress banner the renderer already shows.
  ipcMain.handle(IPC_CHANNELS.GIT_PULL_REBASE, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['pull', '--rebase'], { cwd, timeout: 60000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      const stdout = e.stdout ? e.stdout.toString().trim() : '';
      return { ok: false, message: stderr || stdout || e.message || 'rebase pull failed' };
    }
  });

  // Pull from upstream. Uses git's configured pull strategy
  // (merge / rebase / ff-only) — surface git's own error message on
  // conflict / divergence rather than guessing.
  ipcMain.handle(IPC_CHANNELS.GIT_PULL, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['pull'], { cwd, timeout: 60000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      const stdout = e.stdout ? e.stdout.toString().trim() : '';
      return { ok: false, message: stderr || stdout || e.message || 'pull failed' };
    }
  });

  // Merge a source ref into the current branch.
  //
  // Refuses up front when:
  //   - cwd isn't a git repo
  //   - the working tree is dirty (we'd lose changes mid-merge)
  //   - HEAD is detached (no branch to merge into)
  //   - the source ref equals the current branch (self-merge)
  //
  // On conflict we deliberately leave the merge in-progress so the user
  // can resolve in their shell and `git commit`. We surface the list of
  // conflicted files so the renderer can show them.
  ipcMain.handle(
    IPC_CHANNELS.GIT_MERGE,
    (_, cwd: string, sourceRef: string): GitMergeResult => {
      if (
        !sourceRef ||
        sourceRef.startsWith('-') ||
        sourceRef.includes('..') ||
        !/^[A-Za-z0-9._/+@-]+$/.test(sourceRef)
      ) {
        return { ok: false, error: 'invalid' };
      }

      const run = (cmd: string): string => {
        try { return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
        catch { return ''; }
      };

      const isGit = run('git rev-parse --is-inside-work-tree') === 'true';
      if (!isGit) return { ok: false, error: 'not-git' };

      const dirty = run('git status --porcelain');
      if (dirty) return { ok: false, error: 'dirty' };

      const currentBranch = run('git symbolic-ref --quiet --short HEAD');
      if (!currentBranch) return { ok: false, error: 'detached' };

      if (sourceRef === currentBranch || sourceRef === 'HEAD') {
        return { ok: false, error: 'self' };
      }

      try {
        execFileSync('git', ['merge', sourceRef], {
          cwd, timeout: 60000, encoding: 'utf-8',
        });
        return { ok: true };
      } catch (err) {
        // Detect conflicts. We deliberately do NOT abort — user resolves
        // in the shell pane.
        const status = run('git status --porcelain');
        const conflictedFiles: string[] = [];
        for (const line of status.split('\n')) {
          if (!line) continue;
          const x = line[0];
          const y = line[1];
          if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
            conflictedFiles.push(line.slice(3).replace(/^"(.*)"$/, '$1'));
          }
        }
        if (conflictedFiles.length > 0) {
          return { ok: false, error: 'conflict', conflictedFiles };
        }
        const e = err as { stderr?: string | Buffer; message?: string };
        const stderr = e.stderr ? e.stderr.toString().trim() : '';
        return { ok: false, error: 'failed', message: stderr || e.message || 'merge failed' };
      }
    },
  );

  // Abort an in-progress merge. Safe to call even if no merge is active —
  // git will return non-zero, which we surface as `ok: false`.
  ipcMain.handle(IPC_CHANNELS.GIT_MERGE_ABORT, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['merge', '--abort'], { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      const e = err as { stderr?: string | Buffer; message?: string };
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      return { ok: false, message: stderr || e.message || 'merge --abort failed' };
    }
  });

  // Dry-run a merge with `git merge-tree --write-tree` (git ≥ 2.38) so
  // the user can see whether it would conflict — and which files — before
  // starting. Never touches the working tree or index (T-060).
  ipcMain.handle(IPC_CHANNELS.GIT_MERGE_PREVIEW, (_, cwd: string, sourceRef: string): GitMergePreviewResult => {
    if (
      !sourceRef ||
      sourceRef.startsWith('-') ||
      sourceRef.includes('..') ||
      !/^[A-Za-z0-9._/+@-]+$/.test(sourceRef)
    ) {
      return { ok: false, error: 'invalid' };
    }
    const tryRun = (args: string[]): string | null => {
      try { return execFileSync('git', args, { cwd, timeout: 10000, encoding: 'utf-8' }); }
      catch { return null; }
    };
    if (tryRun(['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
      return { ok: false, error: 'not-git' };
    }
    // Ref must resolve to a commit, else merge-tree's "not a valid object"
    // would be mistaken for "unsupported git".
    if (tryRun(['rev-parse', '--verify', '--quiet', `${sourceRef}^{commit}`]) == null) {
      return { ok: false, error: 'failed', message: `Ref not found: ${sourceRef}` };
    }
    try {
      execFileSync('git', ['merge-tree', '--write-tree', '--name-only', 'HEAD', sourceRef], {
        cwd, timeout: 30000, encoding: 'utf-8',
      });
      return { ok: true, supported: true, clean: true, conflictedFiles: [] };
    } catch (err) {
      const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      if (e.status === 1) {
        // Conflicts. Output: tree OID, then conflicted paths until a blank line.
        const stdout = e.stdout ? e.stdout.toString() : '';
        const lines = stdout.split('\n');
        const conflictedFiles: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].trim() === '') break;
          conflictedFiles.push(lines[i].replace(/^"(.*)"$/, '$1'));
        }
        return { ok: true, supported: true, clean: false, conflictedFiles };
      }
      const stderr = e.stderr ? e.stderr.toString() : '';
      if (/usage:|unknown option|--write-tree/i.test(stderr)) {
        // git too old for `merge-tree --write-tree`.
        return { ok: true, supported: false };
      }
      return { ok: false, error: 'failed', message: stderr.trim() || e.message || 'merge preview failed' };
    }
  });

  // Resolve one conflicted file wholesale to one side: `git checkout
  // --ours|--theirs -- <file>` then stage it. Args are passed to
  // execFileSync (no shell) and the path sits after `--`, so unusual
  // filenames are safe (T-060).
  ipcMain.handle(IPC_CHANNELS.GIT_CHECKOUT_OURS_THEIRS, (_, cwd: string, filePath: string, side: 'ours' | 'theirs'): GitOpResult => {
    if (!filePath || filePath.startsWith('-')) return { ok: false, message: 'Invalid path.' };
    if (side !== 'ours' && side !== 'theirs') return { ok: false, message: 'Invalid side.' };
    try {
      execFileSync('git', ['checkout', `--${side}`, '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
      execFileSync('git', ['add', '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      const e = err as { stderr?: string | Buffer; message?: string };
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      return { ok: false, message: stderr || e.message || `checkout --${side} failed` };
    }
  });

  // ── Stashes & branch management ────────────────────────────────

  // Helper: validate that a string is a safe ref / branch name. Rejects
  // shell metacharacters, leading dashes (would parse as flag), and
  // path-traversal `..`. Hex-only short SHAs and standard ref characters
  // pass through. Used by every branch/tag op below.
  const isSafeRefName = (s: string): boolean =>
    !!s && !s.startsWith('-') && !s.includes('..') && /^[A-Za-z0-9._/+@-]+$/.test(s);

  const stderrMsg = (err: unknown, fallback: string): string => {
    const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    return stderr || stdout || e.message || fallback;
  };

  // List stashes. Format `stash@{N}\tmessage` per line via -z so messages
  // with tabs / newlines can't break the parse.
  ipcMain.handle(IPC_CHANNELS.GIT_LIST_STASHES, (_, cwd: string): GitStash[] => {
    try {
      const out = execFileSync(
        'git',
        ['stash', 'list', '-z', '--format=%gd%x09%gs'],
        { cwd, timeout: 5000, encoding: 'utf-8' },
      );
      const stashes: GitStash[] = [];
      const records = out.split('\0');
      for (const rec of records) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const ref = rec.slice(0, tab);
        const message = rec.slice(tab + 1);
        // ref looks like `stash@{N}`; pull N out for an ordered index.
        const m = ref.match(/^stash@\{(\d+)\}$/);
        const index = m ? parseInt(m[1], 10) : -1;
        // Stash messages typically read `WIP on <branch>: <sha> <subj>` or
        // `On <branch>: <user message>`. Best-effort branch extraction.
        const bm = message.match(/^(?:WIP on|On)\s+([^\s:]+):/);
        stashes.push({ index, ref, message, branch: bm ? bm[1] : '' });
      }
      // Newest first (lowest index).
      stashes.sort((a, b) => a.index - b.index);
      return stashes;
    } catch {
      return [];
    }
  });

  // Save current working changes to a new stash. `message` is optional;
  // when empty git uses its default "WIP on <branch>" form. Includes
  // untracked files too (Fork's default).
  ipcMain.handle(
    IPC_CHANNELS.GIT_STASH_SAVE,
    (_, cwd: string, message: string): GitOpResult => {
      const args = ['stash', 'push', '--include-untracked'];
      if (message && message.trim()) args.push('-m', message.trim());
      try {
        execFileSync('git', args, { cwd, timeout: 30000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'stash failed') };
      }
    },
  );

  // Apply / pop / drop a stash by ref (`stash@{N}`).
  const stashOp = (
    cwd: string, ref: string, op: 'apply' | 'pop' | 'drop',
  ): GitOpResult => {
    if (!/^stash@\{\d+\}$/.test(ref)) {
      return { ok: false, message: 'invalid stash ref' };
    }
    try {
      execFileSync('git', ['stash', op, ref], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, `stash ${op} failed`) };
    }
  };
  ipcMain.handle(IPC_CHANNELS.GIT_STASH_APPLY, (_, cwd: string, ref: string) => stashOp(cwd, ref, 'apply'));
  ipcMain.handle(IPC_CHANNELS.GIT_STASH_POP, (_, cwd: string, ref: string) => stashOp(cwd, ref, 'pop'));
  ipcMain.handle(IPC_CHANNELS.GIT_STASH_DROP, (_, cwd: string, ref: string) => stashOp(cwd, ref, 'drop'));

  // Create a new local branch. Optional `startPoint` (SHA / ref) — if
  // omitted, the branch is created from the current HEAD.
  ipcMain.handle(
    IPC_CHANNELS.GIT_CREATE_BRANCH,
    (_, cwd: string, name: string, startPoint?: string): GitOpResult => {
      if (!isSafeRefName(name)) return { ok: false, message: 'invalid branch name' };
      if (startPoint && !isSafeRefName(startPoint)) return { ok: false, message: 'invalid start point' };
      const args = ['branch', name];
      if (startPoint) args.push(startPoint);
      try {
        execFileSync('git', args, { cwd, timeout: 10000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'create branch failed') };
      }
    },
  );

  // Delete a local branch. `force=false` uses `-d` (refuses unmerged);
  // `force=true` uses `-D` for forced delete. We pass force through so the
  // renderer can prompt and re-call with force=true after confirmation.
  ipcMain.handle(
    IPC_CHANNELS.GIT_DELETE_BRANCH,
    (_, cwd: string, name: string, force: boolean): GitOpResult => {
      if (!isSafeRefName(name)) return { ok: false, message: 'invalid branch name' };
      try {
        execFileSync('git', ['branch', force ? '-D' : '-d', name], {
          cwd, timeout: 10000, encoding: 'utf-8',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'delete branch failed') };
      }
    },
  );

  // Delete a remote branch — `git push <remote> --delete <name>`. We expect
  // the renderer to pass remote + the bare branch name (without the
  // `<remote>/` prefix), so we never accidentally include the remote name
  // in the deleted branch on the server side.
  ipcMain.handle(
    IPC_CHANNELS.GIT_DELETE_REMOTE_BRANCH,
    (_, cwd: string, remote: string, branch: string): GitOpResult => {
      if (!isSafeRefName(remote) || !isSafeRefName(branch)) {
        return { ok: false, message: 'invalid remote or branch' };
      }
      try {
        execFileSync('git', ['push', remote, '--delete', branch], {
          cwd, timeout: 60000, encoding: 'utf-8',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'delete remote branch failed') };
      }
    },
  );

  // Delete a tag locally. (Pushing the deletion to a remote is a separate
  // op the user can do via terminal for now.)
  ipcMain.handle(
    IPC_CHANNELS.GIT_DELETE_TAG,
    (_, cwd: string, name: string): GitOpResult => {
      if (!isSafeRefName(name)) return { ok: false, message: 'invalid tag name' };
      try {
        execFileSync('git', ['tag', '-d', name], { cwd, timeout: 10000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'delete tag failed') };
      }
    },
  );

  // ── Rebase ─────────────────────────────────────────────────────
  // Mirrors GitMergeResult: clean run → ok:true; conflict → leave the
  // rebase in-progress and return the list of conflicted files; refuse
  // up front when the working tree is dirty or HEAD is detached.
  const collectConflicts = (cwd: string): string[] => {
    try {
      const out = execFileSync('git', ['status', '--porcelain', '-z'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      });
      const conflicted: string[] = [];
      for (const rec of out.split('\0')) {
        if (!rec || rec.length < 3) continue;
        const x = rec[0];
        const y = rec[1];
        if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
          conflicted.push(rec.slice(3));
        }
      }
      return conflicted;
    } catch {
      return [];
    }
  };

  ipcMain.handle(
    IPC_CHANNELS.GIT_REBASE,
    (_, cwd: string, ontoRef: string): GitRebaseResult => {
      if (!isSafeRefName(ontoRef)) return { ok: false, error: 'invalid' };

      const isGit = (() => {
        try { return execSync('git rev-parse --is-inside-work-tree', { cwd, timeout: 5000, encoding: 'utf-8' }).trim() === 'true'; }
        catch { return false; }
      })();
      if (!isGit) return { ok: false, error: 'not-git' };

      try {
        const dirty = execSync('git status --porcelain', { cwd, timeout: 5000, encoding: 'utf-8' }).trim();
        if (dirty) return { ok: false, error: 'dirty' };
      } catch { /* fall through, git will tell us */ }

      let currentBranch = '';
      try {
        currentBranch = execSync('git symbolic-ref --quiet --short HEAD', {
          cwd, timeout: 5000, encoding: 'utf-8',
        }).trim();
      } catch { /* detached */ }
      if (!currentBranch) return { ok: false, error: 'detached' };
      if (ontoRef === currentBranch || ontoRef === 'HEAD') return { ok: false, error: 'self' };

      try {
        execFileSync('git', ['rebase', ontoRef], { cwd, timeout: 60000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        const conflictedFiles = collectConflicts(cwd);
        if (conflictedFiles.length > 0) {
          return { ok: false, error: 'conflict', conflictedFiles };
        }
        return { ok: false, error: 'failed', message: stderrMsg(err, 'rebase failed') };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.GIT_REBASE_ABORT, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['rebase', '--abort'], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'rebase --abort failed') };
    }
  });

  // After the user resolves conflicts in their shell and stages the
  // resolutions, this runs `git rebase --continue` to advance through
  // the rebase. May produce another conflict on a subsequent commit;
  // surface the same `conflict` shape so the banner stays.
  ipcMain.handle(IPC_CHANNELS.GIT_REBASE_CONTINUE, (_, cwd: string): GitRebaseResult => {
    try {
      // GIT_EDITOR=true makes `--continue` reuse the existing commit
      // message non-interactively (otherwise git tries to launch $EDITOR).
      execFileSync('git', ['rebase', '--continue'], {
        cwd, timeout: 60000, encoding: 'utf-8',
        env: { ...process.env, GIT_EDITOR: 'true' },
      });
      return { ok: true };
    } catch (err) {
      const conflictedFiles = collectConflicts(cwd);
      if (conflictedFiles.length > 0) {
        return { ok: false, error: 'conflict', conflictedFiles };
      }
      return { ok: false, error: 'failed', message: stderrMsg(err, 'rebase --continue failed') };
    }
  });

  // Interactive rebase (T-033). Writes the user's prepared todo list
  // to a temp file, writes a tiny shim script that copies it into
  // the path git passes to GIT_SEQUENCE_EDITOR, then runs
  // `git rebase -i <base>`. GIT_EDITOR=true keeps reword/squash
  // message edits non-interactive (V1: accept git's defaults).
  ipcMain.handle(IPC_CHANNELS.GIT_REBASE_INTERACTIVE, (_, cwd: string, base: string, todoLines: string[]): GitRebaseResult => {
    if (!isSafeRefName(base) && !/^[0-9a-f]{7,40}$/.test(base)) {
      return { ok: false, error: 'invalid' };
    }
    if (!Array.isArray(todoLines) || todoLines.length === 0) {
      return { ok: false, error: 'invalid' };
    }
    // Validate every line — refuse anything we don't expect git to
    // accept. Prevents a user-supplied string from sneaking shell
    // syntax in through the todo file (git itself wouldn't run it,
    // but rejecting upfront makes the failure mode obvious).
    const todoRe = /^(pick|reword|edit|squash|fixup|drop) [0-9a-f]{7,40}( .*)?$/;
    for (const line of todoLines) {
      if (!todoRe.test(line)) return { ok: false, error: 'failed', message: `bad todo line: ${line}` };
    }

    const isGit = (() => {
      try { return execSync('git rev-parse --is-inside-work-tree', { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() === 'true'; }
      catch { return false; }
    })();
    if (!isGit) return { ok: false, error: 'not-git' };

    try {
      const dirty = execSync('git status --porcelain', { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (dirty) return { ok: false, error: 'dirty' };
    } catch { /* fall through */ }

    let currentBranch = '';
    try {
      currentBranch = execSync('git symbolic-ref --quiet --short HEAD', {
        cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { /* detached */ }
    if (!currentBranch) return { ok: false, error: 'detached' };

    // Determine the rebase base: prefer <base>^ (so `base` itself is
    // included in the editable range). Fall back to `--root` when
    // base has no parent.
    let baseArg = '';
    let useRoot = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', `${base}^`], {
        cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      baseArg = `${base}^`;
    } catch {
      useRoot = true;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vyb-rebase-'));
    try {
      const todoPath = path.join(tmp, 'todo');
      fs.writeFileSync(todoPath, todoLines.join('\n') + '\n', 'utf-8');
      // Write the platform-specific sequence-editor shim. The shim
      // copies our prepared todo over the file git passes as its
      // first arg, then exits 0 — git reads the result and proceeds.
      let shimPath: string;
      if (process.platform === 'win32') {
        shimPath = path.join(tmp, 'seq-editor.cmd');
        fs.writeFileSync(shimPath, '@copy /Y "%VYB_TODO%" %1 >NUL\r\n', 'utf-8');
      } else {
        shimPath = path.join(tmp, 'seq-editor.sh');
        fs.writeFileSync(shimPath, '#!/bin/sh\ncat "$VYB_TODO" > "$1"\n', 'utf-8');
        fs.chmodSync(shimPath, 0o755);
      }
      const env = {
        ...process.env,
        GIT_SEQUENCE_EDITOR: shimPath,
        GIT_EDITOR: 'true',
        VYB_TODO: todoPath,
      };
      const args = ['rebase', '-i'];
      if (useRoot) args.push('--root');
      else args.push(baseArg);
      execFileSync('git', args, {
        cwd, timeout: 300000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, env,
      });
      return { ok: true };
    } catch (err) {
      const conflictedFiles = collectConflicts(cwd);
      if (conflictedFiles.length > 0) {
        return { ok: false, error: 'conflict', conflictedFiles };
      }
      // Detect the "stopped for edit/break" case: git's rebase state
      // exists in `.git/rebase-merge/` after a stop. Surface as
      // conflict-shape (no actual conflict, but the banner stays so
      // the user can Continue or Abort).
      try {
        const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
          cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const gitDirAbs = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
        if (fs.existsSync(path.join(gitDirAbs, 'rebase-merge'))) {
          return { ok: false, error: 'conflict', conflictedFiles: [] };
        }
      } catch { /* fall through */ }
      return { ok: false, error: 'failed', message: stderrMsg(err, 'rebase -i failed') };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // ── Tracking ──────────────────────────────────────────────────
  // Set / unset the upstream of a local branch. `upstream` is the full
  // remote-tracking name like "origin/main". When `branch` is empty we
  // operate on HEAD (the user's current branch).
  ipcMain.handle(
    IPC_CHANNELS.GIT_SET_UPSTREAM,
    (_, cwd: string, branch: string, upstream: string): GitOpResult => {
      if (branch && !isSafeRefName(branch)) return { ok: false, message: 'invalid branch' };
      if (!isSafeRefName(upstream)) return { ok: false, message: 'invalid upstream' };
      const args = ['branch', `--set-upstream-to=${upstream}`];
      if (branch) args.push(branch);
      try {
        execFileSync('git', args, { cwd, timeout: 10000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'set upstream failed') };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_UNSET_UPSTREAM,
    (_, cwd: string, branch: string): GitOpResult => {
      if (branch && !isSafeRefName(branch)) return { ok: false, message: 'invalid branch' };
      const args = ['branch', '--unset-upstream'];
      if (branch) args.push(branch);
      try {
        execFileSync('git', args, { cwd, timeout: 10000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'unset upstream failed') };
      }
    },
  );

  // ── Remote management (T-034) ─────────────────────────────────
  //
  // Remote NAMES are validated with a tighter ruleset than ref names
  // because they show up in remote-tracking paths like `origin/main`
  // and slashes inside the remote name would break our `<remote>/<branch>`
  // grouping in BranchTree. URLs are passed through with a length cap
  // and a `--` guard so they can't be mistaken for flags.
  const isSafeRemoteName = (s: string): boolean =>
    /^[A-Za-z0-9._-]+$/.test(s) && s.length > 0 && s.length < 256;
  const isSafeRemoteUrl = (s: string): boolean =>
    s.length > 0 && s.length < 2048 && !s.startsWith('-');

  ipcMain.handle(IPC_CHANNELS.GIT_LIST_REMOTES, (_, cwd: string): import('../shared/types').GitRemote[] => {
    if (!cwd) return [];
    try {
      const out = execFileSync('git', ['remote', '-v'], {
        cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const byName = new Map<string, import('../shared/types').GitRemote>();
      for (const line of out.split('\n')) {
        // Format: "<name>\t<url> (fetch)" or "<name>\t<url> (push)"
        const m = line.match(/^(\S+)\t(.+) \((fetch|push)\)$/);
        if (!m) continue;
        const [, name, url, kind] = m;
        const existing = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
        if (kind === 'fetch') existing.fetchUrl = url;
        else existing.pushUrl = url;
        byName.set(name, existing);
      }
      // Fill missing side from the other so callers never see empty
      // strings unexpectedly.
      const result: import('../shared/types').GitRemote[] = [];
      for (const r of byName.values()) {
        if (!r.pushUrl) r.pushUrl = r.fetchUrl;
        if (!r.fetchUrl) r.fetchUrl = r.pushUrl;
        result.push(r);
      }
      result.sort((a, b) => a.name.localeCompare(b.name));
      return result;
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_ADD_REMOTE, (_, cwd: string, name: string, url: string): GitOpResult => {
    if (!isSafeRemoteName(name)) return { ok: false, message: 'invalid remote name' };
    if (!isSafeRemoteUrl(url)) return { ok: false, message: 'invalid remote URL' };
    try {
      execFileSync('git', ['remote', 'add', '--', name, url], { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'add remote failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_RENAME_REMOTE, (_, cwd: string, oldName: string, newName: string): GitOpResult => {
    if (!isSafeRemoteName(oldName) || !isSafeRemoteName(newName)) {
      return { ok: false, message: 'invalid remote name' };
    }
    try {
      execFileSync('git', ['remote', 'rename', '--', oldName, newName], { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'rename remote failed') };
    }
  });

  // `opts.push === true` writes only the push URL; otherwise writes
  // the fetch URL (which also becomes the push URL unless one was
  // previously set separately). V1 wires only the unified path from
  // the renderer — the `push` flag is here for the V2 split-url UI.
  ipcMain.handle(IPC_CHANNELS.GIT_SET_REMOTE_URL, (_, cwd: string, name: string, url: string, opts?: { push?: boolean }): GitOpResult => {
    if (!isSafeRemoteName(name)) return { ok: false, message: 'invalid remote name' };
    if (!isSafeRemoteUrl(url)) return { ok: false, message: 'invalid remote URL' };
    try {
      const args = ['remote', 'set-url'];
      if (opts?.push) args.push('--push');
      args.push('--', name, url);
      execFileSync('git', args, { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'set remote URL failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_REMOVE_REMOTE, (_, cwd: string, name: string): GitOpResult => {
    if (!isSafeRemoteName(name)) return { ok: false, message: 'invalid remote name' };
    try {
      execFileSync('git', ['remote', 'remove', '--', name], { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'remove remote failed') };
    }
  });

  // Local branches tracking a given remote — used by the Remove-remote
  // confirmation dialog to surface "X branches will lose their upstream".
  ipcMain.handle(IPC_CHANNELS.GIT_REMOTE_TRACKING_BRANCHES, (_, cwd: string, remoteName: string): string[] => {
    if (!isSafeRemoteName(remoteName)) return [];
    try {
      const out = execFileSync('git', [
        'for-each-ref', '--format=%(refname:short) %(upstream:remotename)', 'refs/heads',
      ], { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const result: string[] = [];
      for (const line of out.split('\n')) {
        if (!line) continue;
        const sep = line.lastIndexOf(' ');
        if (sep === -1) continue;
        const branch = line.slice(0, sep);
        const upstreamRemote = line.slice(sep + 1);
        if (upstreamRemote === remoteName) result.push(branch);
      }
      return result;
    } catch {
      return [];
    }
  });

  // ── Rename branch ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.GIT_RENAME_BRANCH,
    (_, cwd: string, oldName: string, newName: string): GitOpResult => {
      if (!isSafeRefName(oldName) || !isSafeRefName(newName)) {
        return { ok: false, message: 'invalid branch name' };
      }
      try {
        execFileSync('git', ['branch', '-m', oldName, newName], {
          cwd, timeout: 10000, encoding: 'utf-8',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'rename branch failed') };
      }
    },
  );

  // ── Worktree ──────────────────────────────────────────────────
  // `git worktree add <path> <branch>` checks `branch` out into a fresh
  // working tree at `path`. We don't track the worktree ourselves —
  // the user can open it as a separate Vyb profile.
  ipcMain.handle(
    IPC_CHANNELS.GIT_ADD_WORKTREE,
    (_, cwd: string, worktreePath: string, branch: string): GitOpResult => {
      if (!worktreePath || !isSafeRefName(branch)) {
        return { ok: false, message: 'invalid worktree path or branch' };
      }
      try {
        execFileSync('git', ['worktree', 'add', worktreePath, branch], {
          cwd, timeout: 60000, encoding: 'utf-8',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'worktree add failed') };
      }
    },
  );

  // List worktrees (T-035). Parses `git worktree list --porcelain`:
  // blank-line-separated records of `worktree <path>`, `HEAD <sha>`,
  // `branch <full-ref>` (or `detached`), `bare`, and `locked <reason>`.
  // The first record is the main worktree. We also flag worktrees
  // whose path lives under Vyb's parallel-agents directory so the UI
  // can grey them out and disable Remove.
  ipcMain.handle(IPC_CHANNELS.GIT_LIST_WORKTREES, (_, cwd: string): import('../shared/types').GitWorktree[] => {
    if (!cwd) return [];
    const systemPrefix = path.join(app.getPath('userData'), 'parallel-agents') + path.sep;
    try {
      const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const records = out.split(/\n\n+/);
      const result: import('../shared/types').GitWorktree[] = [];
      let mainSeen = false;
      for (const record of records) {
        const trimmed = record.trim();
        if (!trimmed) continue;
        let worktreePath = '';
        let head = '';
        let branch: string | undefined = undefined;
        let isDetached = false;
        let isBare = false;
        let isLocked = false;
        let lockedReason: string | undefined = undefined;
        for (const line of trimmed.split('\n')) {
          if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length);
          else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
          else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
          else if (line === 'detached') isDetached = true;
          else if (line === 'bare') isBare = true;
          else if (line === 'locked' || line.startsWith('locked ')) {
            isLocked = true;
            lockedReason = line === 'locked' ? '' : line.slice('locked '.length);
          }
        }
        if (!worktreePath) continue;
        const isMain = !mainSeen;
        mainSeen = true;
        result.push({
          path: worktreePath,
          branch,
          head,
          isMain,
          isDetached,
          isBare,
          isLocked,
          lockedReason,
          isSystemManaged: worktreePath.startsWith(systemPrefix),
        });
      }
      return result;
    } catch {
      return [];
    }
  });

  // Remove worktree (T-035). Refuses to touch the main worktree or a
  // Vyb-managed parallel-agent worktree as a belt-and-suspenders
  // against UI misclicks; the renderer also disables those rows.
  ipcMain.handle(IPC_CHANNELS.GIT_REMOVE_WORKTREE, (_, cwd: string, worktreePath: string, force: boolean): GitOpResult => {
    if (!cwd || !worktreePath) return { ok: false, message: 'invalid worktree path' };
    const systemPrefix = path.join(app.getPath('userData'), 'parallel-agents') + path.sep;
    if (worktreePath.startsWith(systemPrefix)) {
      return { ok: false, message: 'Refusing to remove a parallel-agent worktree from this UI.' };
    }
    // Compare against the main worktree's top-level path. `git
    // rev-parse --show-toplevel` returns the current worktree's top;
    // for the main worktree the user is likely operating from there
    // anyway, but they could also be in a linked worktree. Use
    // --git-common-dir as the cross-reference.
    try {
      const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // commonDir points at .git for the main worktree; its parent is
      // the main worktree path.
      const mainPath = path.resolve(cwd, commonDir, '..');
      if (path.resolve(worktreePath) === mainPath) {
        return { ok: false, message: 'Cannot remove the main worktree. Delete the repo instead.' };
      }
    } catch {
      // best-effort; if rev-parse fails we still let git refuse.
    }
    try {
      const args = ['worktree', 'remove'];
      if (force) args.push('--force');
      args.push('--', worktreePath);
      execFileSync('git', args, { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'worktree remove failed') };
    }
  });

  // Reflog (T-036). Parses `git log -g` for the named ref (default
  // HEAD). Capped at 1000 entries — useful recovery range; users
  // chasing deeper can drop to the shell. We use NUL separators +
  // RS terminators so subjects containing tabs/newlines parse
  // cleanly, same trick as GIT_LOG.
  ipcMain.handle(IPC_CHANNELS.GIT_REFLOG, (_, cwd: string, ref: string, limit: number): import('../shared/types').GitReflogEntry[] => {
    if (!cwd) return [];
    const cap = Math.max(1, Math.min(5000, (limit ?? 500) | 0 || 500));
    const target = ref && /^[A-Za-z0-9._/-]+$/.test(ref) ? ref : 'HEAD';
    try {
      const fmt = '%H%x00%gD%x00%gs%x00%aI%x00%s%x00%x1e';
      const out = execFileSync('git', [
        'log', '-g',
        `--max-count=${cap}`,
        `--pretty=format:${fmt}`,
        target,
      ], { cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      const entries: import('../shared/types').GitReflogEntry[] = [];
      for (const record of out.split('\x1e')) {
        const trimmed = record.replace(/^\n+/, '');
        if (!trimmed) continue;
        const fields = trimmed.split('\x00');
        if (fields.length < 5) continue;
        const [sha, selector, action, time, subject] = fields;
        entries.push({
          sha,
          shortSha: sha.slice(0, 7),
          selector,
          action,
          time,
          subject,
        });
      }
      return entries;
    } catch {
      return [];
    }
  });

  // Bisect (T-041). Four IPCs cover the whole lifecycle. Each one
  // shells out to plain `git bisect …` — no clever state tracking on
  // our side; the panel polls bisectStatus to refresh its banner.
  ipcMain.handle(IPC_CHANNELS.GIT_BISECT_START, (_, cwd: string, goodSha: string, badSha: string): GitOpResult => {
    if (!validateSha(goodSha) || !validateSha(badSha)) return { ok: false, message: 'invalid SHA' };
    if (goodSha === badSha) return { ok: false, message: 'good and bad must differ' };
    try {
      // `git bisect start <bad> <good>` — note the order: bad first
      // is git's CLI convention.
      execFileSync('git', ['bisect', 'start', badSha, goodSha], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'bisect start failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_BISECT_MARK, (_, cwd: string, kind: 'good' | 'bad' | 'skip'): GitOpResult => {
    if (kind !== 'good' && kind !== 'bad' && kind !== 'skip') return { ok: false, message: 'invalid mark' };
    try {
      execFileSync('git', ['bisect', kind], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, `bisect ${kind} failed`) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_BISECT_RESET, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['bisect', 'reset'], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'bisect reset failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_BISECT_STATUS, (_, cwd: string): import('../shared/types').GitBisectStatus => {
    const empty: import('../shared/types').GitBisectStatus = { inProgress: false, goodCount: 0, badCount: 0, stepsRemaining: -1 };
    if (!cwd) return empty;
    // `git rev-parse --git-dir` resolves to the per-worktree git dir
    // (matters for linked worktrees — they have their own bisect state).
    let gitDir: string;
    try {
      gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { return empty; }
    const gitDirAbs = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    if (!fs.existsSync(path.join(gitDirAbs, 'BISECT_LOG'))) return empty;
    try {
      // Parse `git bisect log` for the counts. Each line of interest is
      // "git bisect good <sha>" / "git bisect bad <sha>" / "git bisect
      // skip <sha>". The first "# first <bad|good> commit:" line
      // signals a found commit.
      const log = execFileSync('git', ['bisect', 'log'], {
        cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      let goodCount = 0;
      let badCount = 0;
      let foundSha: string | undefined;
      for (const line of log.split('\n')) {
        const t = line.trim();
        if (/^git bisect good /.test(t)) goodCount++;
        else if (/^git bisect bad /.test(t)) badCount++;
        else if (/^#\s+first (bad|good) commit:/i.test(t)) {
          // The next line in the log is "<sha> <subject>" — capture
          // its SHA. Simpler: parse from `git bisect view` below.
        }
      }
      // Use `bisect view` to grab the current HEAD (one we're testing).
      let currentSha: string | undefined;
      let currentSubject: string | undefined;
      try {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (head) currentSha = head;
        if (head) {
          const subj = execFileSync('git', ['log', '-1', '--pretty=%s', head], { cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          currentSubject = subj;
        }
      } catch { /* best-effort */ }
      // Estimate remaining steps using `git bisect run` machinery:
      // `git bisect visualize --pretty=oneline | wc -l` gives the
      // bisectable range count. log2(n) is the rough step count.
      let stepsRemaining = -1;
      try {
        const range = execFileSync('git', ['rev-list', '--bisect-vars'], { cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const m = range.match(/bisect_nr=(\d+)/);
        if (m) {
          const n = parseInt(m[1], 10);
          stepsRemaining = n > 0 ? Math.ceil(Math.log2(n + 1)) : 0;
        }
      } catch { /* best-effort */ }
      // Detect found-commit by checking BISECT_RUN_BAD / BISECT_NAMES /
      // BISECT_TERMS, OR simpler: if the most recent line in the log is
      // a "first bad commit" comment, the next line has the SHA.
      const logLines = log.split('\n');
      for (let i = 0; i < logLines.length; i++) {
        if (/^#\s+first (bad|good) commit:/i.test(logLines[i])) {
          const next = logLines[i + 1] ?? '';
          const m = next.trim().match(/^([0-9a-f]{7,40})\s+(.*)$/);
          if (m) {
            foundSha = m[1];
            if (m[2]) currentSubject = m[2];
          }
        }
      }
      return {
        inProgress: true,
        currentSha,
        currentSubject,
        goodCount,
        badCount,
        stepsRemaining,
        foundSha,
        foundSubject: foundSha ? currentSubject : undefined,
      };
    } catch {
      return empty;
    }
  });

  // ── Git LFS (T-040) ───────────────────────────────────────────
  // Every handler treats `git lfs not installed` as a soft failure
  // and returns an empty/false result so the renderer's LFS section
  // can show an empty-state hint instead of an error toast.
  ipcMain.handle(IPC_CHANNELS.GIT_LFS_INFO, (_, cwd: string): import('../shared/types').GitLfsInfo => {
    const empty: import('../shared/types').GitLfsInfo = { available: false, configured: false, trackedSample: [], trackedCount: 0 };
    if (!cwd) return empty;
    // 1) Is the LFS extension on PATH at all?
    try {
      execFileSync('git', ['lfs', 'version'], { cwd, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return empty;
    }
    // 2) Does this repo configure any LFS patterns? `git lfs ls-files`
    // returns rows; empty output ⇒ not configured.
    let trackedSample: string[] = [];
    let trackedCount = 0;
    let configured = false;
    try {
      const out = execFileSync('git', ['lfs', 'ls-files'], {
        cwd, timeout: 8000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Each line: "<oid> [*-] <path>" — keep just the path.
      const paths: string[] = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^[0-9a-f]+\s+[*-]\s+(.+)$/);
        if (m) paths.push(m[1]);
      }
      trackedCount = paths.length;
      trackedSample = paths.slice(0, 50);
      configured = trackedCount > 0;
    } catch {
      // ls-files may fail in a fresh repo even with lfs available.
    }
    return { available: true, configured, trackedSample, trackedCount };
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LFS_LIST_LOCKS, (_, cwd: string): import('../shared/types').GitLfsLock[] => {
    if (!cwd) return [];
    try {
      // `--json` is supported by recent git-lfs and is the cleanest
      // parsing path. Fall back to plain output if json fails.
      const out = execFileSync('git', ['lfs', 'locks', '--json'], {
        cwd, timeout: 8000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      });
      try {
        const parsed = JSON.parse(out);
        if (Array.isArray(parsed)) {
          return parsed.map((l: { id?: string; path?: string; owner?: { name?: string }; locked_at?: string }) => ({
            id: String(l.id ?? ''),
            path: String(l.path ?? ''),
            owner: String(l.owner?.name ?? ''),
            lockedAt: l.locked_at,
          })).filter((l) => l.path);
        }
      } catch { /* fall through */ }
      // Plain output: "<id> <path> [<user>]"
      const result: import('../shared/types').GitLfsLock[] = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^(\S+)\s+(.+?)\s+(\S+)\s*$/);
        if (m) result.push({ id: m[1], path: m[2], owner: m[3] });
      }
      return result;
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LFS_LOCK, (_, cwd: string, filePath: string): GitOpResult => {
    if (!filePath) return { ok: false, message: 'no path' };
    try {
      execFileSync('git', ['lfs', 'lock', '--', filePath], { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'lfs lock failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LFS_UNLOCK, (_, cwd: string, filePath: string, force: boolean): GitOpResult => {
    if (!filePath) return { ok: false, message: 'no path' };
    try {
      const args = ['lfs', 'unlock'];
      if (force) args.push('--force');
      args.push('--', filePath);
      execFileSync('git', args, { cwd, timeout: 10000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'lfs unlock failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LFS_FETCH, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['lfs', 'fetch'], { cwd, timeout: 120000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'lfs fetch failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LFS_PRUNE, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['lfs', 'prune'], { cwd, timeout: 120000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'lfs prune failed') };
    }
  });

  // ── Submodules (T-039) ────────────────────────────────────────
  // `git submodule status` output: "<status><sha> <path> [(describe)]"
  // where <status> is one of ' ', '-', '+', 'U'. We also peek into
  // `.gitmodules` for the URL of each entry so the right-click menu
  // can show it.
  ipcMain.handle(IPC_CHANNELS.GIT_SUBMODULES_LIST, (_, cwd: string): import('../shared/types').GitSubmodule[] => {
    if (!cwd) return [];
    // Quick check — no .gitmodules means no submodules.
    if (!fs.existsSync(path.join(cwd, '.gitmodules'))) return [];
    let urlMap = new Map<string, string>();
    try {
      const out = execFileSync('git', ['config', '-f', '.gitmodules', '--get-regexp', 'submodule\\..*\\.(path|url)'], {
        cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Pair up `submodule.<name>.path <p>` with `submodule.<name>.url <u>`.
      const pathByName = new Map<string, string>();
      const urlByName = new Map<string, string>();
      for (const line of out.split('\n')) {
        const m = line.match(/^submodule\.([^.]+)\.(path|url) (.+)$/);
        if (!m) continue;
        const [, name, key, value] = m;
        if (key === 'path') pathByName.set(name, value);
        else urlByName.set(name, value);
      }
      urlMap = new Map(Array.from(pathByName.entries()).map(([name, p]) => [p, urlByName.get(name) ?? '']));
    } catch { /* best-effort */ }
    try {
      const out = execFileSync('git', ['submodule', 'status'], {
        cwd, timeout: 10000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const result: import('../shared/types').GitSubmodule[] = [];
      for (const line of out.split('\n')) {
        if (!line) continue;
        const flag = line[0];
        const rest = line.slice(1);
        const m = rest.match(/^([0-9a-f]+)\s+(\S+)(?:\s+\((.+)\))?$/);
        if (!m) continue;
        const sha = m[1];
        const subPath = m[2];
        const describe = m[3];
        let status: 'clean' | 'modified' | 'uninitialised' | 'conflict' = 'clean';
        if (flag === '-') status = 'uninitialised';
        else if (flag === '+') status = 'modified';
        else if (flag === 'U') status = 'conflict';
        result.push({
          path: subPath,
          sha,
          shortSha: sha.slice(0, 7),
          status,
          describe,
          url: urlMap.get(subPath),
        });
      }
      return result;
    } catch {
      return [];
    }
  });

  // Safety guard for submodule paths: must be a known submodule path
  // (parsed from .gitmodules), so we never run `git submodule …` with
  // a user-supplied path that could be flag-like.
  const isKnownSubmodule = (cwd: string, subPath: string): boolean => {
    try {
      const out = execFileSync('git', ['config', '-f', '.gitmodules', '--get-regexp', 'submodule\\..*\\.path'], {
        cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      for (const line of out.split('\n')) {
        const m = line.match(/^submodule\.[^.]+\.path (.+)$/);
        if (m && m[1] === subPath) return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  ipcMain.handle(IPC_CHANNELS.GIT_SUBMODULE_INIT, (_, cwd: string, subPath: string): GitOpResult => {
    if (!isKnownSubmodule(cwd, subPath)) return { ok: false, message: 'unknown submodule path' };
    try {
      execFileSync('git', ['submodule', 'init', '--', subPath], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'submodule init failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_SUBMODULE_UPDATE, (_, cwd: string, subPath: string, remote: boolean): GitOpResult => {
    if (!isKnownSubmodule(cwd, subPath)) return { ok: false, message: 'unknown submodule path' };
    try {
      const args = ['submodule', 'update', '--init'];
      if (remote) args.push('--remote');
      args.push('--', subPath);
      execFileSync('git', args, { cwd, timeout: 300000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'submodule update failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_SUBMODULE_SYNC, (_, cwd: string, subPath: string): GitOpResult => {
    if (!isKnownSubmodule(cwd, subPath)) return { ok: false, message: 'unknown submodule path' };
    try {
      execFileSync('git', ['submodule', 'sync', '--', subPath], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'submodule sync failed') };
    }
  });

  // ── Pull request via gh ───────────────────────────────────────
  // Shells out to the GitHub CLI. `gh pr create --fill` reuses the
  // commit message as title/body; if the user passes an explicit
  // title/body we use those instead.
  ipcMain.handle(
    IPC_CHANNELS.GIT_CREATE_PR,
    (_, cwd: string, title: string, body: string): GitCreatePrResult => {
      const args = ['pr', 'create'];
      if (title && title.trim()) {
        args.push('--title', title.trim(), '--body', body ?? '');
      } else {
        args.push('--fill');
      }
      try {
        const out = execFileSync('gh', args, {
          cwd, timeout: 60000, encoding: 'utf-8',
        }).trim();
        // gh prints the PR URL on the last line.
        const lines = out.split('\n').filter(Boolean);
        const url = lines.find((l) => /^https?:\/\//.test(l)) ?? lines[lines.length - 1] ?? '';
        return { ok: true, url };
      } catch (err) {
        const e = err as { code?: string; message?: string; stderr?: string | Buffer };
        if (e.code === 'ENOENT') {
          return { ok: false, message: 'gh CLI not found. Install GitHub CLI from https://cli.github.com.' };
        }
        return { ok: false, message: stderrMsg(err, 'gh pr create failed') };
      }
    },
  );

  // ── Commit-level ops: tag, cherry-pick, revert, reset ─────────

  // Create a tag at a given commit. `message` empty → lightweight tag,
  // non-empty → annotated. Tag names must pass the same safety regex as
  // branch refs.
  ipcMain.handle(
    IPC_CHANNELS.GIT_CREATE_TAG,
    (_, cwd: string, name: string, ref: string, message: string): GitOpResult => {
      if (!isSafeRefName(name)) return { ok: false, message: 'invalid tag name' };
      if (ref && !/^[0-9a-f]{4,40}$/i.test(ref) && !isSafeRefName(ref)) {
        return { ok: false, message: 'invalid commit ref' };
      }
      const args = ['tag'];
      if (message && message.trim()) args.push('-a', name, '-m', message.trim());
      else args.push(name);
      if (ref) args.push(ref);
      try {
        execFileSync('git', args, { cwd, timeout: 10000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'create tag failed') };
      }
    },
  );

  // Cherry-pick a commit onto the current branch. Like merge/rebase, on
  // conflict we leave the cherry-pick in-progress and surface the
  // conflicted files so the renderer can show a banner with
  // Abort + Continue buttons.
  const validateSha = (sha: string): boolean => /^[0-9a-f]{4,40}$/i.test(sha);

  ipcMain.handle(
    IPC_CHANNELS.GIT_CHERRY_PICK,
    (_, cwd: string, sha: string): GitMergeResult => {
      if (!validateSha(sha)) return { ok: false, error: 'invalid' };
      try {
        execFileSync('git', ['cherry-pick', sha], { cwd, timeout: 60000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        const conflicted = collectConflicts(cwd);
        if (conflicted.length > 0) return { ok: false, error: 'conflict', conflictedFiles: conflicted };
        return { ok: false, error: 'failed', message: stderrMsg(err, 'cherry-pick failed') };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.GIT_CHERRY_PICK_ABORT, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['cherry-pick', '--abort'], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'cherry-pick --abort failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CHERRY_PICK_CONTINUE, (_, cwd: string): GitMergeResult => {
    try {
      execFileSync('git', ['cherry-pick', '--continue'], {
        cwd, timeout: 60000, encoding: 'utf-8',
        env: { ...process.env, GIT_EDITOR: 'true' },
      });
      return { ok: true };
    } catch (err) {
      const conflicted = collectConflicts(cwd);
      if (conflicted.length > 0) return { ok: false, error: 'conflict', conflictedFiles: conflicted };
      return { ok: false, error: 'failed', message: stderrMsg(err, 'cherry-pick --continue failed') };
    }
  });

  // Revert a commit (creates a new commit that undoes the changes). On
  // conflict, same in-progress + Abort/Continue pattern as cherry-pick.
  ipcMain.handle(
    IPC_CHANNELS.GIT_REVERT,
    (_, cwd: string, sha: string): GitMergeResult => {
      if (!validateSha(sha)) return { ok: false, error: 'invalid' };
      try {
        // --no-edit: use the default revert message ("Revert <subj>") and
        // commit immediately, no interactive editor.
        execFileSync('git', ['revert', '--no-edit', sha], { cwd, timeout: 60000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        const conflicted = collectConflicts(cwd);
        if (conflicted.length > 0) return { ok: false, error: 'conflict', conflictedFiles: conflicted };
        return { ok: false, error: 'failed', message: stderrMsg(err, 'revert failed') };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.GIT_REVERT_ABORT, (_, cwd: string): GitOpResult => {
    try {
      execFileSync('git', ['revert', '--abort'], { cwd, timeout: 30000, encoding: 'utf-8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: stderrMsg(err, 'revert --abort failed') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_REVERT_CONTINUE, (_, cwd: string): GitMergeResult => {
    try {
      execFileSync('git', ['revert', '--continue'], {
        cwd, timeout: 60000, encoding: 'utf-8',
        env: { ...process.env, GIT_EDITOR: 'true' },
      });
      return { ok: true };
    } catch (err) {
      const conflicted = collectConflicts(cwd);
      if (conflicted.length > 0) return { ok: false, error: 'conflict', conflictedFiles: conflicted };
      return { ok: false, error: 'failed', message: stderrMsg(err, 'revert --continue failed') };
    }
  });

  // Reset the current branch to a commit. `mode` controls what happens
  // to the working tree + index:
  //   - 'soft'  → keep both (changes stay staged)
  //   - 'mixed' → keep working tree, unstage (default git behaviour)
  //   - 'hard'  → discard everything (DESTRUCTIVE)
  ipcMain.handle(
    IPC_CHANNELS.GIT_RESET,
    (_, cwd: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): GitOpResult => {
      if (!validateSha(sha)) return { ok: false, message: 'invalid commit ref' };
      if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') {
        return { ok: false, message: 'invalid reset mode' };
      }
      try {
        execFileSync('git', ['reset', `--${mode}`, sha], { cwd, timeout: 30000, encoding: 'utf-8' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: stderrMsg(err, 'reset failed') };
      }
    },
  );

  // Topo-ordered log of every reachable commit across all refs (capped).
  // Format uses NUL separators between fields and a record terminator so we
  // never have to worry about commit subjects containing tabs or newlines
  // breaking the parse.
  //
  // NOTE: T-042's signature fields (%G? / %GS) used to live here but were
  // moved out — those placeholders force git to shell out to gpg per
  // commit, which on a thousand-commit log freezes the Electron main
  // process well past the 15 s execSync timeout. Signatures are now
  // fetched lazily via `git:commitSignatures` after the tree renders.
  ipcMain.handle(
    IPC_CHANNELS.GIT_LOG,
    (_, cwd: string, limit: number): GitCommit[] => {
      const cap = Math.max(1, Math.min(10000, limit | 0 || 1000));
      try {
        const fmt = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%x1e';
        const out = execSync(
          `git log --all --topo-order --max-count=${cap} --pretty=format:${fmt}`,
          { cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
        );
        const commits: GitCommit[] = [];
        for (const record of out.split('\x1e')) {
          const trimmed = record.replace(/^\n+/, '');
          if (!trimmed) continue;
          const fields = trimmed.split('\x00');
          if (fields.length < 6) continue;
          const [sha, parents, author, email, date, subject] = fields;
          commits.push({
            sha,
            parents: parents ? parents.split(' ').filter(Boolean) : [],
            author,
            email,
            date,
            subject,
          });
        }
        return commits;
      } catch {
        return [];
      }
    },
  );

  // Lazy signature lookup (T-042 follow-up). Spawns `git log --pretty`
  // with %G? / %GS in a child process so the Electron main loop stays
  // responsive while gpg verification runs. The renderer calls this
  // after the main tree loads; results are merged into commits whose
  // SHAs match. Returns a sparse map — entries with sigStatus 'N' (no
  // signature) are dropped so the payload stays small.
  ipcMain.handle(
    IPC_CHANNELS.GIT_COMMIT_SIGNATURES,
    async (_, cwd: string, limit: number): Promise<Record<string, { sigStatus: string; sigSigner: string }>> => {
      const cap = Math.max(1, Math.min(10000, limit | 0 || 1000));
      return await new Promise((resolve) => {
        const fmt = '%H%x00%G?%x00%GS%x00%x1e';
        const child = spawn('git', ['log', '--all', '--topo-order', `--max-count=${cap}`, `--pretty=format:${fmt}`], { cwd });
        let out = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }, 60_000); // 60 s — gpg verification of large repos can be slow
        child.stdout.on('data', (chunk) => { out += chunk.toString('utf-8'); });
        child.on('error', () => { clearTimeout(timer); resolve({}); });
        child.on('close', () => {
          clearTimeout(timer);
          if (timedOut) { resolve({}); return; }
          const map: Record<string, { sigStatus: string; sigSigner: string }> = {};
          for (const record of out.split('\x1e')) {
            const trimmed = record.replace(/^\n+/, '');
            if (!trimmed) continue;
            const fields = trimmed.split('\x00');
            if (fields.length < 3) continue;
            const [sha, sigStatus, sigSigner] = fields;
            if (sigStatus && sigStatus !== 'N') {
              map[sha] = { sigStatus, sigSigner: sigSigner || '' };
            }
          }
          resolve(map);
        });
      });
    },
  );

  // All refs (local branches, remote-tracking branches, tags) plus a flag
  // for the current HEAD. We also peel tags so annotated tags resolve to
  // the underlying commit (otherwise they'd point at the tag object SHA).
  ipcMain.handle(
    IPC_CHANNELS.GIT_LIST_REFS,
    (_, cwd: string): GitRef[] => {
      const run = (cmd: string): string => {
        try {
          return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch {
          return '';
        }
      };

      const isGit = run('git rev-parse --is-inside-work-tree') === 'true';
      if (!isGit) return [];

      const headSha = run('git rev-parse HEAD');
      const headBranch = run('git symbolic-ref --quiet --short HEAD'); // empty when detached

      // for-each-ref does NOT interpret %xx hex escapes (unlike `git log
      // --pretty=format:`), and we can't put NUL bytes directly into argv
      // (kernel-level NUL-terminated C strings). Use tabs instead — git's
      // refname rules forbid control characters in branch/tag names, so a
      // tab can never appear inside a refname.
      let raw = '';
      try {
        raw = execFileSync(
          'git',
          [
            'for-each-ref',
            '--format=%(refname)\t%(objectname)\t%(*objectname)',
            'refs/heads',
            'refs/remotes',
            'refs/tags',
          ],
          { cwd, timeout: 5000, encoding: 'utf-8' },
        ).trim();
      } catch {
        raw = '';
      }
      if (!raw) return [];

      const refs: GitRef[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        const [fullName, objectSha, peeledSha] = line.split('\t');
        // Annotated tags: peeledSha is the underlying commit; for branches
        // and lightweight tags peeledSha is empty so we use objectSha.
        const sha = peeledSha || objectSha;

        if (fullName.startsWith('refs/heads/')) {
          const name = fullName.slice('refs/heads/'.length);
          refs.push({
            name,
            fullName,
            sha,
            type: 'local',
            isHead: !!headBranch && name === headBranch,
          });
        } else if (fullName.startsWith('refs/remotes/')) {
          const rest = fullName.slice('refs/remotes/'.length);
          // Skip the symbolic origin/HEAD pointer — it duplicates a real
          // branch and adds noise to the graph labels.
          if (rest.endsWith('/HEAD')) continue;
          const slash = rest.indexOf('/');
          const remote = slash === -1 ? rest : rest.slice(0, slash);
          const name = slash === -1 ? rest : rest;
          refs.push({
            name,
            fullName,
            sha,
            type: 'remote',
            remote,
            isHead: false,
          });
        } else if (fullName.startsWith('refs/tags/')) {
          refs.push({
            name: fullName.slice('refs/tags/'.length),
            fullName,
            sha,
            type: 'tag',
            isHead: false,
          });
        }
      }

      // Detached HEAD — synthesise a pseudo-ref so the UI can highlight
      // wherever HEAD currently sits.
      if (!headBranch && headSha) {
        refs.push({
          name: 'HEAD',
          fullName: 'HEAD',
          sha: headSha,
          type: 'local',
          isHead: true,
        });
      }

      return refs;
    },
  );

  // Checkout an arbitrary commit. Refuses when the working tree has changes
  // — `git checkout <sha>` would fail anyway in most cases, but we want a
  // clean structured error so the UI can show a helpful message.
  ipcMain.handle(
    IPC_CHANNELS.GIT_CHECKOUT_COMMIT,
    (_, cwd: string, target: string): GitCheckoutResult => {
      // Defence in depth: SHAs and branch names only — block anything that
      // could break out of the argv (shell metacharacters, leading dash so
      // git won't treat it as a flag, parent-traversal `..`).
      if (
        !target ||
        target.startsWith('-') ||
        target.includes('..') ||
        !/^[A-Za-z0-9._/+@-]+$/.test(target)
      ) {
        return { ok: false, error: 'failed', message: 'invalid checkout target' };
      }
      try {
        const isGit = execSync('git rev-parse --is-inside-work-tree', {
          cwd, timeout: 5000, encoding: 'utf-8',
        }).trim() === 'true';
        if (!isGit) return { ok: false, error: 'not-git' };

        const dirty = execSync('git status --porcelain', {
          cwd, timeout: 5000, encoding: 'utf-8',
        }).trim();
        if (dirty) return { ok: false, error: 'dirty' };

        // Use execFileSync so the target is passed as a single argv entry
        // (no shell parsing on top of the regex check above).
        execFileSync('git', ['checkout', target], {
          cwd, timeout: 15000, encoding: 'utf-8',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: 'failed', message: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.FILE_LIST_DIR, (_, dirPath: string): FileEntry[] => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      // Dotfiles (.gitignore, .env, .vscode/, etc.) are listed —
      // users working on projects need them visible. Sort puts
      // directories first, then alphabetical; hidden entries fall
      // naturally at the top of each group because '.' < any letter.
      return entries
        .map((e) => ({
          name: e.name,
          path: path.join(dirPath, e.name),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [];
    }
  });

  // List every file under `cwd` for the quick-open picker (T-043).
  // Prefers `git ls-files` (fast, .gitignore-aware) when inside a
  // git repo; falls back to a recursive walk otherwise. Returns
  // forward-slash paths relative to `cwd`. Capped so the picker
  // never has to render an unbounded list — 10k is enough headroom
  // for most repos; bigger trees just truncate.
  ipcMain.handle(IPC_CHANNELS.FILE_LIST_PROJECT, (_, cwd: string): string[] => {
    if (!cwd) return [];
    const CAP = 10000;
    // Try git ls-files first. `--cached --others --exclude-standard`
    // returns tracked + untracked, honouring .gitignore.
    try {
      const out = execFileSync('git', [
        'ls-files', '--cached', '--others', '--exclude-standard', '-z',
      ], {
        cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const result: string[] = [];
      for (const p of out.split('\0')) {
        if (!p) continue;
        result.push(p);
        if (result.length >= CAP) break;
      }
      if (result.length > 0) return result;
    } catch { /* fall through to walk */ }
    // Fallback: BFS walk skipping common heavy directories.
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.vite', 'coverage', '.idea', '.vscode']);
    const result: string[] = [];
    const stack: string[] = [''];
    while (stack.length > 0 && result.length < CAP) {
      const rel = stack.pop()!;
      const abs = rel ? path.join(cwd, rel) : cwd;
      let entries: import('fs').Dirent[];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
        if (SKIP.has(entry.name)) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          stack.push(childRel);
        } else if (entry.isFile()) {
          result.push(childRel);
          if (result.length >= CAP) break;
        }
      }
    }
    return result;
  });

  // Cross-file search (T-044). Spawns ripgrep with --json, parses
  // its newline-delimited records, and returns up to 500 matches.
  // ripgrep absent → returns `fallbackUsed: true` with no matches
  // so the renderer can hint about installing it. We don't ship a
  // node-glob walker as a real fallback in V1; that path's purely
  // informational.
  ipcMain.handle(
    IPC_CHANNELS.FILE_SEARCH_IN_FILES,
    async (_, cwd: string, query: string, opts?: import('../shared/types').FileSearchOptions): Promise<import('../shared/types').FileSearchResult> => {
      const empty: import('../shared/types').FileSearchResult = { matches: [], truncated: false, fallbackUsed: false };
      if (!cwd || !query) return empty;
      const CAP = 500;
      const args: string[] = ['--json', '--max-count', '50', '--max-filesize', '2M'];
      if (!opts?.caseSensitive) args.push('-i');
      if (opts?.wholeWord) args.push('-w');
      if (!opts?.regex) args.push('-F'); // fixed string
      if (opts?.include) {
        for (const g of opts.include.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
          args.push('-g', g);
        }
      }
      if (opts?.exclude) {
        for (const g of opts.exclude.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
          args.push('-g', `!${g}`);
        }
      }
      args.push('--', query, '.');
      return await new Promise<import('../shared/types').FileSearchResult>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('rg', args, { cwd });
        } catch {
          resolve({ ...empty, fallbackUsed: true, error: 'ripgrep not installed' });
          return;
        }
        let stdoutBuf = '';
        let stderrBuf = '';
        const matches: import('../shared/types').FileSearchMatch[] = [];
        let truncated = false;
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }, 30_000);
        child.stdout?.setEncoding('utf-8');
        child.stdout?.on('data', (chunk: string) => {
          stdoutBuf += chunk;
          let nl: number;
          while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line.trim()) continue;
            try {
              const rec = JSON.parse(line) as {
                type: string;
                data: {
                  path?: { text: string };
                  line_number?: number;
                  lines?: { text: string };
                  submatches?: { start: number; end: number }[];
                };
              };
              if (rec.type !== 'match') continue;
              if (matches.length >= CAP) {
                truncated = true;
                try { child.kill('SIGTERM'); } catch { /* ignore */ }
                break;
              }
              const path = rec.data.path?.text ?? '';
              const lineNumber = rec.data.line_number ?? 0;
              const text = (rec.data.lines?.text ?? '').replace(/\r?\n$/, '');
              const sub = rec.data.submatches?.[0];
              matches.push({
                path,
                lineNumber,
                line: text.length > 500 ? text.slice(0, 500) + '…' : text,
                matchStart: sub?.start ?? 0,
                matchEnd: sub?.end ?? 0,
              });
            } catch { /* skip malformed lines */ }
          }
        });
        child.stderr?.setEncoding('utf-8');
        child.stderr?.on('data', (chunk: string) => { stderrBuf += chunk; });
        child.on('error', () => {
          clearTimeout(timer);
          resolve({ ...empty, fallbackUsed: true, error: 'ripgrep not installed' });
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve({
            matches,
            truncated,
            fallbackUsed: false,
            error: stderrBuf.trim() && matches.length === 0 ? stderrBuf.trim() : undefined,
          });
        });
      });
    },
  );

  // Format a buffer through Prettier (T-045). Prettier infers the
  // parser from `filepath`; we pass the file path so it works for
  // .ts vs .tsx vs .json. Project config (.prettierrc, etc.) is
  // resolved relative to the file's path so a repo's local prefs
  // override Prettier's defaults. Returns the formatted content or
  // `{ error }` for the renderer to surface in a toast.
  ipcMain.handle(IPC_CHANNELS.FILE_FORMAT, async (_, filePath: string, content: string): Promise<{ content?: string; error?: string }> => {
    if (!filePath) return { error: 'missing path' };
    // Lazy-require so the renderer never tries to pull Prettier
    // into its bundle (it's externalized in vite.main.config.ts,
    // but require() also stays out of any code path the renderer
    // could reach).
    let prettier: typeof import('prettier');
    try {
      prettier = await import('prettier');
    } catch {
      return { error: 'Prettier is not available in this build.' };
    }
    try {
      const config = await prettier.resolveConfig(filePath).catch((): null => null);
      const formatted = await prettier.format(content, {
        ...(config ?? {}),
        filepath: filePath,
      });
      return { content: formatted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'format failed';
      return { error: msg };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_READ, (_, filePath: string): string | null => {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_SAVE, (_, filePath: string, content: string): boolean => {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      return true;
    } catch {
      return false;
    }
  });

  // ── Filesystem watcher (drives auto-refresh of the file tree + open
  //     tabs when files change underneath Vyb — e.g. an agent writes to
  //     them). One fs.watch per FileExplorer instance, keyed by an id we
  //     hand back to the renderer.
  //
  //   On macOS + Windows we use fs.watch with `recursive: true` which is
  //   cheap (FSEvents / ReadDirectoryChangesW). On Linux that flag is a
  //   no-op for non-watched subdirs — events still fire for the top
  //   level which is enough to drive a refresh (the renderer re-runs
  //   listDir on every event), so we don't bother with a recursive
  //   walk. Noise filters drop the usual suspects (.git, node_modules,
  //   dist, etc.). */
  const fileWatchers = new Map<string, fs.FSWatcher>();
  let nextFileWatchId = 1;
  const WATCH_IGNORE_SEGMENTS = new Set([
    '.git', 'node_modules', '.next', '.vite', '.turbo', 'dist', 'build',
    'out', '.cache', '.parcel-cache', 'coverage', '.nyc_output',
    '.idea', '.vscode', '.DS_Store',
  ]);
  // Cloud-sync roots that routinely hold 100k+ files (often dataless
  // placeholders). A recursive fs.watch over these enumerates the whole
  // subtree on macOS and spikes memory into a fatal V8 allocation —
  // never recurse into them.
  const CLOUD_SYNC_DIRS = new Set([
    'Dropbox', 'Google Drive', 'GoogleDrive', 'OneDrive', 'OneDrive - Personal',
    'Creative Cloud Files', 'iCloud Drive', 'Library', 'Mobile Documents',
    'Sync', 'pCloud Drive', 'Box', 'Box Sync', 'MEGA', 'Nextcloud',
  ]);
  function watchPathIsNoise(rel: string): boolean {
    if (!rel) return false;
    for (const segment of rel.split(/[\\/]/)) {
      if (WATCH_IGNORE_SEGMENTS.has(segment)) return true;
    }
    return false;
  }

  // Bounded probe: is the tree small enough to safely watch recursively?
  // We breadth-walk readdir (which lists names only — does NOT hydrate
  // dataless cloud placeholders) skipping noise + cloud roots, and bail
  // the moment we exceed a node cap or a time budget. Because we
  // early-exit, even a 100k-file home dir costs only a few MB here —
  // unlike fs.watch({recursive:true}) which would enumerate the whole
  // thing and crash the process. Returns false → caller uses a cheap
  // non-recursive (top-level only) watch instead.
  const RECURSIVE_WATCH_MAX_NODES = 50000;
  const RECURSIVE_WATCH_TIME_BUDGET_MS = 1500;
  function treeFitsForRecursiveWatch(root: string): boolean {
    const start = Date.now();
    let count = 0;
    const stack: string[] = [root];
    while (stack.length) {
      if (count > RECURSIVE_WATCH_MAX_NODES) return false;
      if (Date.now() - start > RECURSIVE_WATCH_TIME_BUDGET_MS) return false;
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable subdir — skip, keep probing
      }
      for (const e of entries) {
        if (++count > RECURSIVE_WATCH_MAX_NODES) return false;
        if (e.isDirectory()) {
          if (WATCH_IGNORE_SEGMENTS.has(e.name)) continue;
          if (CLOUD_SYNC_DIRS.has(e.name)) return false; // cloud root present → too risky
          stack.push(path.join(dir, e.name));
        }
      }
    }
    return true;
  }

  ipcMain.handle(IPC_CHANNELS.FILE_WATCH_START, (_, cwd: string): string | null => {
    if (!cwd) return null;
    try {
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return null;
    } catch {
      return null;
    }
    const id = `fw-${nextFileWatchId++}`;
    // Only watch recursively when the tree is provably small enough.
    // For oversized / cloud-heavy directories we fall back to a
    // non-recursive watch: top-level changes still drive a refresh, and
    // we avoid the FSEvents enumeration that crashes the process. The
    // user can still expand + manually refresh deeper folders.
    const recursive = treeFitsForRecursiveWatch(cwd);
    if (!recursive) {
      console.warn(`[file-watch] ${cwd} is large or contains cloud-sync roots — using non-recursive watch to avoid OOM`);
    }
    try {
      const watcher = fs.watch(cwd, { recursive, persistent: true }, (eventType, filename) => {
        const rel = (filename ?? '').toString();
        if (watchPathIsNoise(rel)) return;
        const abs = rel ? path.join(cwd, rel) : cwd;
        safeSend(IPC_CHANNELS.FILE_WATCH_CHANGE, {
          watchId: id,
          eventType,
          absPath: abs,
          relPath: rel,
        });
      });
      watcher.on('error', () => {
        // Best effort — if the watcher dies (e.g. directory removed), let
        // the renderer notice via its next manual refresh.
      });
      fileWatchers.set(id, watcher);
      return id;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_WATCH_STOP, (_, watchId: string) => {
    const watcher = fileWatchers.get(watchId);
    if (!watcher) return;
    try { watcher.close(); } catch { /* already closed */ }
    fileWatchers.delete(watchId);
  });

  // Reuses the same bounded probe the watcher uses: true means the
  // directory is large/cloud-heavy enough that the file tree may be
  // slow and deep auto-refresh is disabled. Drives a one-time renderer
  // warning. Cheap — the probe early-exits.
  ipcMain.handle(IPC_CHANNELS.FILE_DIR_IS_LARGE, (_, cwd: string): boolean => {
    if (!cwd) return false;
    try {
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return false;
    } catch {
      return false;
    }
    return !treeFitsForRecursiveWatch(cwd);
  });

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, (_, targetPath: string): boolean => {
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true });
      } else {
        fs.unlinkSync(targetPath);
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_RENAME, (_, oldPath: string, newPath: string): boolean => {
    try {
      fs.renameSync(oldPath, newPath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_COPY, (_, srcPath: string, destPath: string): boolean => {
    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_CREATE_DIR, (_, dirPath: string): boolean => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_SAVE_AS, async (_, content: string, defaultPath: string): Promise<string | null> => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save As',
      defaultPath,
    });
    if (result.canceled || !result.filePath) return null;
    try {
      fs.writeFileSync(result.filePath, content, 'utf-8');
      return result.filePath;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_CREATE, (_, filePath: string): boolean => {
    try {
      fs.writeFileSync(filePath, '', 'utf-8');
      return true;
    } catch {
      return false;
    }
  });

  // Resolve a file token (e.g. "src/main.ts" or just "main.ts") emitted in agent
  // output to an absolute path. If the token already contains a separator, we
  // resolve it directly against the working directory. If it's a bare filename,
  // we BFS from the working directory — depth ascending, files alphabetical at
  // each level — and return the first match. Lazy: only runs on link click.
  ipcMain.handle(
    IPC_CHANNELS.FILE_RESOLVE_PATH,
    (_, workingDir: string, token: string): string | null => {
      if (!workingDir || !token) return null;

      // Strip optional :line, :line:col, or :line-line range suffix. The
      // ranged form shows up in tracebacks like `controller.py:254-273`.
      const cleaned = token.replace(/:\d+(?:[-:]\d+)?$/, '').trim();
      if (!cleaned) return null;

      const isAbs = path.isAbsolute(cleaned);
      const looksLikePath = isAbs || cleaned.includes('/') || cleaned.includes('\\');

      const candidate = isAbs ? cleaned : path.resolve(workingDir, cleaned);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // fall through to BFS
      }

      if (looksLikePath) return null;

      // Bare filename — BFS from workingDir, alphabetical, skip noise dirs.
      const SKIP_DIRS = new Set([
        'node_modules', '.git', '.next', '.vite', '.turbo', 'dist', 'build', 'out',
        '.cache', '.parcel-cache', 'coverage', '.nyc_output', '.idea', '.vscode',
      ]);
      const MAX_VISITED = 20000;

      const target = cleaned;
      const queue: string[] = [workingDir];
      let visited = 0;

      while (queue.length > 0 && visited < MAX_VISITED) {
        const dir = queue.shift()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const subdirs: string[] = [];
        for (const e of entries) {
          visited++;
          if (e.isFile() && e.name === target) {
            return path.join(dir, e.name);
          }
          if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
            subdirs.push(path.join(dir, e.name));
          }
        }
        for (const s of subdirs) queue.push(s);
      }

      return null;
    },
  );

  ipcMain.handle(IPC_CHANNELS.README_LOAD, (_, workingDirectory: string): string | null => {
    const names = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
    for (const name of names) {
      const filePath = path.join(workingDirectory, name);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    }
    return null;
  });

  ipcMain.handle(
    IPC_CHANNELS.ORDNA_START,
    async (_, instanceKey: string, profileId: string, cwd: string, mode: 'web' | 'tui') => {
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return { error: 'profile not found' };
      try {
        const result = await ordnaManager.start(instanceKey, profileId, cwd, mode);
        return result;
      } catch (err) {
        console.error('Ordna start failed:', err);
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.ORDNA_STOP, async (_, instanceKey: string) => {
    await ordnaManager.stop(instanceKey);
  });

  ipcMain.handle(IPC_CHANNELS.ORDNA_GET_WEB_URL, (_, instanceKey: string) => {
    const inst = ordnaManager.getInstance(instanceKey);
    if (!inst) return null;
    return { mode: inst.mode, webUrl: inst.webUrl ?? null, tuiPtyId: inst.tuiPtyId ?? null };
  });

  ipcMain.handle(IPC_CHANNELS.ORDNA_HOOK_INFO, () => {
    return { url: ordnaHookServer.getHookUrl(), port: ordnaHookServer.getActivePort() };
  });

  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_AGENT_SPAWN,
    async (_, profileId: string, task: { id: string; title: string; filePath?: string }) => {
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return { error: 'profile not found' };
      const settings = loadSettings();
      const agentsCfg = settings.agents || DEFAULT_AGENTS;
      try {
        const agent = await parallelManager.spawn(profile, agentsCfg, task);
        return agent;
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.PARALLEL_AGENT_DESTROY, async (_, id: string, discardWork?: boolean) => {
    await parallelManager.destroy(id, discardWork === true);
  });

  ipcMain.handle(IPC_CHANNELS.PARALLEL_AGENT_LIST, (_, profileId?: string): ParallelAgent[] => {
    return parallelManager.list(profileId);
  });

  ipcMain.handle(IPC_CHANNELS.PARALLEL_AGENT_FINISH, async (_, id: string) => {
    const agent = parallelManager.get(id);
    const ownerProfile = agent ? profiles.find((p) => p.id === agent.profileId) : undefined;
    const autoPush = ownerProfile?.parallelAgentAutoPush === true;
    await parallelManager.finish(id, autoPush);
  });

  ipcMain.handle(
    IPC_CHANNELS.GENERATE_ICON,
    async (_, profileId: string, projectName: string): Promise<string | null> => {
      const settings = loadSettings();
      const prompt = `Make a project icon for the project "${projectName}" that matches the following universe: ${settings.iconPromptPrefix}`;

      // Resolve the reference image: prefer the containing folder's
      // `referenceImage` (set via the folder-config modal) when present,
      // otherwise fall back to the global `settings.iconReferenceImage`.
      let referenceImagePath = settings.iconReferenceImage;
      try {
        const layout = loadLayout();
        const folder = layout.folders.find((f) => f.profileIds.includes(profileId));
        if (folder?.referenceImage && fs.existsSync(folder.referenceImage)) {
          referenceImagePath = folder.referenceImage;
        }
      } catch { /* layout may be empty/missing — stick with the global */ }

      // Load reference image if configured
      let refImageBase64: string | null = null;
      let refMimeType = 'image/png';
      if (referenceImagePath && fs.existsSync(referenceImagePath)) {
        const refBuf = fs.readFileSync(referenceImagePath);
        refImageBase64 = refBuf.toString('base64');
        const refExt = path.extname(referenceImagePath).toLowerCase();
        if (refExt === '.jpg' || refExt === '.jpeg') refMimeType = 'image/jpeg';
        else if (refExt === '.webp') refMimeType = 'image/webp';
      }

      let imageBase64: string;
      let ext = 'png';

      if (settings.iconProvider === 'openai') {
        // --- OpenAI ---
        if (!settings.openaiApiKey) {
          throw new Error('OpenAI API key not configured. Set it in Settings.');
        }

        if (refImageBase64) {
          // Use edits endpoint with reference image
          const boundary = `----formdata${Date.now()}`;
          const refBuffer = fs.readFileSync(referenceImagePath);

          // Build multipart form data manually
          const parts: Buffer[] = [];
          const addField = (name: string, value: string) => {
            parts.push(Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            ));
          };
          addField('model', settings.openaiModel || 'gpt-image-1');
          addField('prompt', prompt + ' Use the provided image as a style reference. Generate a new icon in the same visual style.');
          addField('n', '1');
          addField('size', '1024x1024');

          // Add image file
          const imgExt = path.extname(referenceImagePath).toLowerCase();
          const imgMime = imgExt === '.png' ? 'image/png' : 'image/jpeg';
          parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="ref${imgExt}"\r\nContent-Type: ${imgMime}\r\n\r\n`,
          ));
          parts.push(refBuffer);
          parts.push(Buffer.from('\r\n'));
          parts.push(Buffer.from(`--${boundary}--\r\n`));

          const body = Buffer.concat(parts);

          const response = await fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${settings.openaiApiKey}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
          }

          const data = await response.json();
          const imageData = data?.data?.[0]?.b64_json;
          if (!imageData) {
            throw new Error('No image returned from OpenAI API');
          }
          imageBase64 = imageData;
        } else {
          // No reference — use generations endpoint
          const response = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${settings.openaiApiKey}`,
            },
            body: JSON.stringify({
              model: settings.openaiModel || 'gpt-image-1',
              prompt,
              n: 1,
              size: '1024x1024',
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
          }

          const data = await response.json();
          const imageData = data?.data?.[0]?.b64_json;
          if (!imageData) {
            throw new Error('No image returned from OpenAI API');
          }
          imageBase64 = imageData;
        }
      } else {
        // --- Gemini ---
        if (!settings.geminiApiKey) {
          throw new Error('Gemini API key not configured. Set it in Settings.');
        }

        const model = settings.geminiModel || 'gemini-3.1-flash-image-preview';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        // Build parts: text prompt + optional reference image
        const contentParts: unknown[] = [
          { text: refImageBase64
            ? prompt + ' Use the provided image as a style reference. Generate a new icon in the same visual style.'
            : prompt },
        ];
        if (refImageBase64) {
          contentParts.push({
            inline_data: {
              mime_type: refMimeType,
              data: refImageBase64,
            },
          });
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': settings.geminiApiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: contentParts }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Gemini API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const respParts = data?.candidates?.[0]?.content?.parts;
        const imagePart = respParts?.find(
          (p: { inlineData?: { mimeType: string; data: string } }) => p.inlineData,
        );
        if (!imagePart?.inlineData?.data) {
          throw new Error('No image returned from Gemini API');
        }
        imageBase64 = imagePart.inlineData.data;
        ext = imagePart.inlineData.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      }

      // Save the image to userData/icons/, removing any old icon for this profile
      const iconsDir = path.join(app.getPath('userData'), 'icons');
      if (!fs.existsSync(iconsDir)) {
        fs.mkdirSync(iconsDir, { recursive: true });
      }
      for (const old of ['png', 'jpg', 'jpeg']) {
        const oldPath = path.join(iconsDir, `${profileId}.${old}`);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      const iconPath = path.join(iconsDir, `${profileId}.${ext}`);
      fs.writeFileSync(iconPath, Buffer.from(imageBase64, 'base64'));

      return iconPath;
    },
  );
}

async function initOrdnaHookServer(): Promise<void> {
  const settings = loadSettings();
  let token = settings.ordnaHookToken;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    saveSettings({ ...settings, ordnaHookToken: token });
  }

  try {
    const port = await ordnaHookServer.start({
      preferredPort: settings.ordnaHookPort || 9876,
      token,
      onTask: (payload: OrdnaTaskPayload) => {
        const sourceProfileId = payload.context?.cwd
          ? ordnaManager.resolveProfileByCwd(payload.context.cwd)
          : null;
        safeSend(IPC_CHANNELS.ORDNA_TASK_RECEIVED, { sourceProfileId, payload });
      },
    });
    ordnaManager.setHookEnv(`http://127.0.0.1:${port}/agent`, token);
  } catch (err) {
    console.error('Failed to start Ordna hook server:', err);
  }
}

let cleanupDone = false;
export function cleanupIpcHandlers(): void {
  // Idempotent — before-quit can fire more than once and via more
  // than one path; killing PTYs / saving scrollback twice is wasteful
  // and could double-write files.
  if (cleanupDone) return;
  cleanupDone = true;
  isQuitting = true;
  // Save scrollback only for shells where user actually typed commands
  for (const [profileId, data] of scrollbackBuffers) {
    if (shellHadInput.has(profileId)) {
      saveScrollback(profileId, data);
    }
  }
  if (ordnaManager) {
    ordnaManager.stopAll().catch((): void => undefined);
  }
  if (parallelManager) {
    parallelManager.destroyAll().catch((): void => undefined);
  }
  ordnaHookServer.stop().catch((): void => undefined);
  if (ptyManager) {
    ptyManager.destroyAll();
  }
}
