import { app, ipcMain, shell, dialog, BrowserWindow, Notification } from 'electron';
import { exec } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout } from '../shared/types';
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

  statusDetector = new StatusDetector((profileId, status) => {
    safeSend(IPC_CHANNELS.PROFILE_STATUS_CHANGE, { profileId, status });

    // Send OS notification — skip if window is focused and this is the active profile
    if (isQuitting) return;
    const isFocusedOnThis =
      mainWindow.isFocused() && profileId === activeProfileId;
    if (isFocusedOnThis) return;

    const profile = profiles.find((p) => p.id === profileId);
    if (profile && (status === 'ready' || status === 'needs-input')) {
      const notification = new Notification({
        title: profile.name,
        body: status === 'ready' ? 'Task completed' : 'Needs your input',
      });
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
      statusDetector.setWorking(profileId);
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

  ipcMain.handle(
    IPC_CHANNELS.GENERATE_ICON,
    async (_, profileId: string, projectName: string): Promise<string | null> => {
      const settings = loadSettings();
      if (!settings.geminiApiKey) {
        throw new Error('Gemini API key not configured. Set it in Settings.');
      }

      const prompt = `Make a project icon for the project "${projectName}" that matches the following universe: ${settings.iconPromptPrefix}`;

      const model = 'gemini-2.5-flash-image';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': settings.geminiApiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
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

      // Find the image part in the response
      const parts = data?.candidates?.[0]?.content?.parts;
      const imagePart = parts?.find(
        (p: { inlineData?: { mimeType: string; data: string } }) => p.inlineData,
      );
      if (!imagePart?.inlineData?.data) {
        throw new Error('No image returned from Gemini API');
      }

      // Save the image to userData/icons/
      const iconsDir = path.join(app.getPath('userData'), 'icons');
      if (!fs.existsSync(iconsDir)) {
        fs.mkdirSync(iconsDir, { recursive: true });
      }

      const ext = imagePart.inlineData.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const iconPath = path.join(iconsDir, `${profileId}.${ext}`);
      fs.writeFileSync(iconPath, Buffer.from(imagePart.inlineData.data, 'base64'));

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
