import { ipcMain, shell, dialog, BrowserWindow, Notification } from 'electron';
import { exec } from 'child_process';
import * as os from 'os';
import { IPC_CHANNELS, Profile, AppSettings } from '../shared/types';
import { PtyManager } from './pty-manager';
import { StatusDetector } from './status-detector';
import { loadProfiles, saveProfiles, loadSettings, saveSettings } from './config-loader';

let ptyManager: PtyManager;
let statusDetector: StatusDetector;
let mainWindow: BrowserWindow;
let profiles: Profile[] = [];
let isQuitting = false;

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

    // Send OS notification on meaningful transitions
    if (isQuitting) return;
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
    const command =
      process.platform === 'win32'
        ? `code.cmd "${folderPath}"`
        : `code "${folderPath}"`;
    exec(command);
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

  ipcMain.handle(IPC_CHANNELS.SETTINGS_LOAD, () => {
    return loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, (_, settings: AppSettings) => {
    saveSettings(settings);
  });
}

export function cleanupIpcHandlers(): void {
  isQuitting = true;
  if (ptyManager) {
    ptyManager.destroyAll();
  }
}
