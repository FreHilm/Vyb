import { app, ipcMain, shell, dialog, BrowserWindow, Notification } from 'electron';
import { exec, execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout, GitStatus, FileEntry } from '../shared/types';
import { PtyManager } from './pty-manager';
import { StatusDetector } from './status-detector';
import { loadProfiles, saveProfiles, loadSettings, saveSettings, loadLayout, saveLayout } from './config-loader';

let ptyManager: PtyManager;
let statusDetector: StatusDetector;
let mainWindow: BrowserWindow;
let profiles: Profile[] = [];
let isQuitting = false;
let activeProfileId: string | null = null;

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

  statusDetector = new StatusDetector((profileId, status, previousStatus) => {
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

    const isFocusedOnThis =
      mainWindow.isFocused() && profileId === activeProfileId;
    if (isFocusedOnThis) return;

    const profile = profiles.find((p) => p.id === profileId);
    if (profile) {
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
  });

  ptyManager = new PtyManager(
    (profileId, data) => {
      safeSend(IPC_CHANNELS.TERMINAL_DATA, { profileId, data });
      statusDetector.feedData(profileId, data);
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
    (_, profileId: string, profile: Profile) => {
      statusDetector.register(profileId, profile);
      ptyManager.create(profileId, profile);
    },
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INPUT,
    (_, profileId: string, data: string) => {
      ptyManager.write(profileId, data);
      if (data === '\r' || data === '\n') {
        statusDetector.setWorking(profileId);
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

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_, cwd: string): GitStatus => {
    const empty: GitStatus = {
      isGit: false, branch: '', modified: 0, staged: 0, untracked: 0,
      ahead: 0, behind: 0, stashes: 0, lastCommit: '',
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

    return { isGit, branch, modified, staged, untracked, ahead, behind, stashes, lastCommit };
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
  if (ptyManager) {
    ptyManager.destroyAll();
  }
}
