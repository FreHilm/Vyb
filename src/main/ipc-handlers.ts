import { app, ipcMain, shell, dialog, BrowserWindow, Notification } from 'electron';
import { exec, execSync, execFileSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout, GitStatus, GitCommit, GitRef, GitCheckoutResult, GitCommitResult, GitOpResult, GitMergeResult, FileEntry, ProfileMemoryMap, OrdnaTaskPayload, ParallelAgent, resolveAgent, DEFAULT_AGENTS } from '../shared/types';
import { PtyManager } from './pty-manager';
import { StatusDetector } from './status-detector';
import { loadProfiles, saveProfiles, loadSettings, saveSettings, loadLayout, saveLayout, loadProfileMemory, saveProfileMemory, loadScrollback, saveScrollback } from './config-loader';
import * as ordnaHookServer from './ordna-hook-server';
import { OrdnaManager } from './ordna-manager';
import { ParallelAgentManager } from './parallel-agent-manager';
import { applyAgentArgsGuards } from './agent-args-guard';


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
      statusDetector.feedData(profileId, data);
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
    },
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DESTROY, (_, profileId: string) => {
    flushCoalesced(profileId);
    clearCoalesced(profileId);
    ptyManager.destroy(profileId);
    statusDetector.unregister(profileId);
    flowStates.delete(profileId);
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

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_, cwd: string): GitStatus => {
    const empty: GitStatus = {
      isGit: false, branch: '', modified: 0, staged: 0, untracked: 0,
      ahead: 0, behind: 0, stashes: 0, lastCommit: '', remoteUrl: '',
      mergeInProgress: false, mergeFromBranch: '', conflictedFiles: [],
    };
    const run = (cmd: string): string => {
      try {
        return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8' }).trim();
      } catch {
        return '';
      }
    };

    // Check if git repo
    const isGit = run('git rev-parse --is-inside-work-tree') === 'true';
    if (!isGit) return empty;

    const branch = run('git branch --show-current') || run('git rev-parse --short HEAD');

    // Porcelain status for counts + conflict detection.
    const statusLines = run('git status --porcelain').split('\n').filter(Boolean);
    let modified = 0;
    let staged = 0;
    let untracked = 0;
    const conflictedFiles: string[] = [];
    for (const line of statusLines) {
      const x = line[0];
      const y = line[1];
      const filePath = line.slice(3).replace(/^"(.*)"$/, '$1');
      // Conflict states per gitstatus(7): UU, AA, DD, AU, UA, DU, UD.
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
    const abStr = run('git rev-list --left-right --count HEAD...@{upstream}');
    if (abStr) {
      const parts = abStr.split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }

    // Stash count
    const stashList = run('git stash list');
    const stashes = stashList ? stashList.split('\n').filter(Boolean).length : 0;

    // Last commit
    const lastCommit = run('git log -1 --pretty=format:%s');

    // Remote URL — convert SSH to HTTPS
    let remoteUrl = run('git remote get-url origin');
    if (remoteUrl) {
      // git@github.com:user/repo.git → https://github.com/user/repo
      remoteUrl = remoteUrl
        .replace(/^git@([^:]+):/, 'https://$1/')
        .replace(/\.git$/, '');
      // Ensure it starts with https
      if (!remoteUrl.startsWith('http')) {
        remoteUrl = '';
      }
    }

    // Merge in progress? .git/MERGE_HEAD exists during a stuck three-way merge.
    // The first line of MERGE_MSG looks like `Merge branch 'feature/foo'` —
    // best-effort grab the source name for the banner.
    let mergeInProgress = false;
    let mergeFromBranch = '';
    try {
      const gitDir = run('git rev-parse --git-dir');
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
      }
    } catch { /* not a real concern, leave defaults */ }

    return {
      isGit, branch, modified, staged, untracked, ahead, behind, stashes, lastCommit, remoteUrl,
      mergeInProgress, mergeFromBranch, conflictedFiles,
    };
  });

  ipcMain.handle(IPC_CHANNELS.GIT_FETCH, (_, cwd: string): boolean => {
    try {
      execSync('git fetch --quiet', { cwd, timeout: 15000, encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CHANGED_FILES, (_, cwd: string): { path: string; added: number; deleted: number; status: string; staged: boolean }[] => {
    const run = (cmd: string): string => {
      try {
        return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
      } catch {
        return '';
      }
    };

    // Parse status porcelain to get file states (staged vs unstaged vs untracked)
    const statusLines = run('git status --porcelain=v1').split('\n').filter(Boolean);
    const fileMap = new Map<string, { status: string; staged: boolean }>();
    for (const line of statusLines) {
      const x = line[0];
      const y = line[1];
      const filePath = line.slice(3).replace(/^"(.*)"$/, '$1');
      if (x === '?') {
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
    }

    // Get line counts: staged (cached) + unstaged
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
    parseNumstat(run('git diff --numstat'));          // unstaged changes
    parseNumstat(run('git diff --cached --numstat')); // staged changes

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
  });

  ipcMain.handle(IPC_CHANNELS.GIT_FILE_DIFF, (_, cwd: string, filePath: string, staged?: boolean): string => {
    const run = (cmd: string): string => {
      try {
        return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
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

    // Untracked / new file — git diff HEAD returns nothing
    if (!diff) {
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
      return true;
    } catch {
      return false;
    }
  });

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

  // Push the current branch to its upstream. If the branch has no upstream
  // configured yet (a fresh local branch), retry with `-u origin <branch>`
  // to publish it — same convenience git itself prints in its hint, just
  // applied automatically.
  ipcMain.handle(IPC_CHANNELS.GIT_PUSH, (_, cwd: string): GitOpResult => {
    const errMsg = (err: unknown, fallback: string): string => {
      const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      const stdout = e.stdout ? e.stdout.toString().trim() : '';
      return stderr || stdout || e.message || fallback;
    };
    try {
      execFileSync('git', ['push'], { cwd, timeout: 60000, encoding: 'utf-8' });
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
          execFileSync('git', ['push', '-u', 'origin', branch], {
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
        try { return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8' }).trim(); }
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

  // Topo-ordered log of every reachable commit across all refs (capped).
  // Format uses NUL separators between fields and a record terminator so we
  // never have to worry about commit subjects containing tabs or newlines
  // breaking the parse.
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

  // All refs (local branches, remote-tracking branches, tags) plus a flag
  // for the current HEAD. We also peel tags so annotated tags resolve to
  // the underlying commit (otherwise they'd point at the tag object SHA).
  ipcMain.handle(
    IPC_CHANNELS.GIT_LIST_REFS,
    (_, cwd: string): GitRef[] => {
      const run = (cmd: string): string => {
        try {
          return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8' }).trim();
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
      return entries
        .filter((e) => !e.name.startsWith('.'))
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

      // Strip optional :line or :line:col suffix.
      const cleaned = token.replace(/:\d+(?::\d+)?$/, '').trim();
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

  ipcMain.handle(IPC_CHANNELS.PARALLEL_AGENT_DESTROY, async (_, id: string) => {
    await parallelManager.destroy(id);
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

      // Load reference image if configured
      let refImageBase64: string | null = null;
      let refMimeType = 'image/png';
      if (settings.iconReferenceImage && fs.existsSync(settings.iconReferenceImage)) {
        const refBuf = fs.readFileSync(settings.iconReferenceImage);
        refImageBase64 = refBuf.toString('base64');
        const refExt = path.extname(settings.iconReferenceImage).toLowerCase();
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
          const refBuffer = fs.readFileSync(settings.iconReferenceImage);

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
          const imgExt = path.extname(settings.iconReferenceImage).toLowerCase();
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

export function cleanupIpcHandlers(): void {
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
