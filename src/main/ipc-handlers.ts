import { app, ipcMain, shell, dialog, BrowserWindow, Notification } from 'electron';
import { exec, execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout, GitStatus, FileEntry, ProfileMemoryMap } from '../shared/types';
import { PtyManager } from './pty-manager';
import { StatusDetector } from './status-detector';
import { loadProfiles, saveProfiles, loadSettings, saveSettings, loadLayout, saveLayout, loadProfileMemory, saveProfileMemory, loadScrollback, saveScrollback } from './config-loader';


let ptyManager: PtyManager;
let statusDetector: StatusDetector;
let mainWindow: BrowserWindow;
let profiles: Profile[] = [];
let isQuitting = false;
const scrollbackBuffers: Map<string, string> = new Map();
const shellHadInput: Set<string> = new Set(); // tracks shells where user typed commands
const MAX_BUFFER = 512 * 1024;
let activeProfileId: string | null = null;

// Flow control — prevent renderer flooding on fast terminal output
const FLOW_HIGH_WATERMARK = 256 * 1024;
const FLOW_LOW_WATERMARK = 64 * 1024;

interface FlowState {
  pending: number;
  paused: boolean;
  buffer: string[];
}
const flowStates: Map<string, FlowState> = new Map();

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

  statusDetector = new StatusDetector((profileId, status, previousStatus, output) => {
    safeSend(IPC_CHANNELS.PROFILE_STATUS_CHANGE, { profileId, status });

    // Only notify on meaningful transitions:
    // - working → ready (task completed)
    // - working → needs-input (permission needed)
    // - ready → needs-input (permission needed)
    // Skip: offline → ready (agent just loaded, not a completed task)
    if (isQuitting) return;
    const isNotifiable =
      (status === 'ready' && previousStatus === 'working') ||
      (status === 'needs-input' && (previousStatus === 'working' || previousStatus === 'ready'));
    if (!isNotifiable) return;

    const profile = profiles.find((p) => p.id === profileId);
    if (profile) {
      // OS notification only if not focused on this profile
      const isFocusedOnThis =
        mainWindow.isFocused() && profileId === activeProfileId;
      if (!isFocusedOnThis) {
        const opts: Electron.NotificationConstructorOptions = {
          title: profile.name,
          body: status === 'ready' ? 'Task completed' : 'Needs your input',
        };
        if (profile.icon && fs.existsSync(profile.icon)) {
          opts.icon = profile.icon;
        }
        const notification = new Notification(opts);
        notification.show();
      }
    }
  });

  ptyManager = new PtyManager(
    (profileId, data) => {
      statusDetector.feedData(profileId, data);
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
        flow.pending += data.length;
        safeSend(IPC_CHANNELS.TERMINAL_DATA, { profileId, data });
        if (flow.pending >= FLOW_HIGH_WATERMARK) {
          flow.paused = true;
        }
      }
    },
    (profileId) => {
      if (profileId.startsWith('shell:')) {
        safeSend(IPC_CHANNELS.SHELL_TERMINAL_EXITED, { terminalId: profileId });
      } else {
        statusDetector.unregister(profileId);
        safeSend(IPC_CHANNELS.PROFILE_STATUS_CHANGE, {
          profileId,
          status: 'offline',
        });
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROFILES_LOAD, () => {
    profiles = loadProfiles();
    return profiles;
  });

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CREATE,
    (_, profileId: string, profile: Profile, cols?: number, rows?: number) => {
      // If claude --continue but no .claude folder exists, drop --continue
      let effectiveProfile = profile;
      if (
        profile.command === 'claude' &&
        profile.args?.includes('--continue')
      ) {
        let cwd = profile.workingDirectory || os.homedir();
        if (cwd.startsWith('~')) cwd = cwd.replace(/^~/, os.homedir());
        if (!fs.existsSync(path.join(cwd, '.claude'))) {
          effectiveProfile = {
            ...profile,
            args: profile.args.filter((a) => a !== '--continue'),
          };
        }
      }
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
        flow.pending += buffered.length;
        safeSend(IPC_CHANNELS.TERMINAL_DATA, { profileId, data: buffered });
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
      properties: ['openDirectory'],
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

  ipcMain.on(IPC_CHANNELS.PROFILE_SET_ACTIVE, (_, profileId: string | null) => {
    activeProfileId = profileId;
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
      defaultPath: `pacc-backup-${new Date().toISOString().slice(0, 10)}.zip`,
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

    // Porcelain status for counts
    const statusLines = run('git status --porcelain').split('\n').filter(Boolean);
    let modified = 0;
    let staged = 0;
    let untracked = 0;
    for (const line of statusLines) {
      const x = line[0];
      const y = line[1];
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

    return { isGit, branch, modified, staged, untracked, ahead, behind, stashes, lastCommit, remoteUrl };
  });

  ipcMain.handle(IPC_CHANNELS.GIT_FETCH, (_, cwd: string): boolean => {
    try {
      execSync('git fetch --quiet', { cwd, timeout: 15000, encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  });

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

export function cleanupIpcHandlers(): void {
  isQuitting = true;
  // Save scrollback only for shells where user actually typed commands
  for (const [profileId, data] of scrollbackBuffers) {
    if (shellHadInput.has(profileId)) {
      saveScrollback(profileId, data);
    }
  }
  if (ptyManager) {
    ptyManager.destroyAll();
  }
}
