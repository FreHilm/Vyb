import { app, BrowserWindow, Menu, ipcMain, protocol, net, nativeImage } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { setupIpcHandlers, cleanupIpcHandlers } from './main/ipc-handlers';
import { resolveShellEnv } from './main/shell-env';
import { IPC_CHANNELS, EditMenuAction, EditMenuState } from './shared/types';

if (started) {
  app.quit();
}

const APP_NAME = 'Vyb';
const LEGACY_APP_NAME = 'AgentDispatch';

// On macOS in dev mode, the menu shows "Electron" because the binary is Electron.app.
// This overrides it by patching the dock and about panel name.
if (process.platform === 'darwin') {
  app.dock?.setBadge('');
  app.setAboutPanelOptions({ applicationName: APP_NAME });
}

// Register a custom protocol to serve local files (icons) to the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, supportFetchAPI: true } },
]);

app.name = APP_NAME;

// Rebrand AgentDispatch → Vyb: a fresh app name moves userData to a new
// directory, which would orphan the user's existing settings.json /
// profiles.json / parallel-agents/ / icons/. Migrate per-file so we still
// recover data even if the new dir already exists with Electron defaults
// (which happens after the very first launch under the new name).
function migrateLegacyUserData(): void {
  try {
    const newDir = app.getPath('userData');
    const legacyDir = newDir.replace(
      new RegExp(`(^|/)${APP_NAME}(/|$)`),
      `$1${LEGACY_APP_NAME}$2`,
    );
    if (legacyDir === newDir) return;
    if (!fs.existsSync(legacyDir)) return;
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });

    // Items that contain user data (vs. Electron's internal cache/cookies).
    const items = [
      'profiles.json',
      'settings.json',
      'layout.json',
      'profile-memory.json',
      'icons',
      'parallel-agents',
      'terminal-states',
    ];
    let moved = 0;
    for (const name of items) {
      const src = path.join(legacyDir, name);
      const dst = path.join(newDir, name);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) continue; // never clobber existing data
      try {
        fs.renameSync(src, dst);
        moved++;
      } catch (err) {
        // Cross-device move can fail with EXDEV — fall back to a recursive copy.
        try {
          fs.cpSync(src, dst, { recursive: true });
          moved++;
        } catch (err2) {
          console.error(`[Vyb] migrate ${name} failed:`, err2);
        }
      }
    }
    if (moved > 0) {
      console.log(`[Vyb] migrated ${moved} item(s) from ${legacyDir} → ${newDir}`);
    }
  } catch (err) {
    console.error('[Vyb] userData migration failed:', err);
  }
}
migrateLegacyUserData();

let mainWindow: BrowserWindow | null = null;

// File-editor Edit menu state, kept in sync with the renderer's FileExplorer.
// `hasFile` enables the menu's edit/clipboard/find items; `canSave` only
// enables Save (Save As is enabled whenever a file is open).
const editMenuState: EditMenuState = { hasFile: false, canSave: false };

function sendEditAction(action: EditMenuAction) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.EDIT_MENU_ACTION, action);
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // IMPORTANT: menu role items (copy/paste/undo/selectAll/reload/etc.) install
  // OS-level key handlers on macOS packaged apps that intercept keys BEFORE
  // the renderer/xterm.js can receive them. Keep the menu minimal — no roles
  // with keyboard accelerators that could conflict with terminal input.
  //
  // The Edit menu below uses click handlers + IPC instead of roles so the
  // editor's CodeMirror still owns Cmd+C / Cmd+Z / Cmd+F natively while
  // letting xterm.js handle the same keys when the terminal is focused.
  const hasFile = editMenuState.hasFile;
  const canSave = editMenuState.hasFile && editMenuState.canSave;
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings...', accelerator: 'Cmd+,', click: openSettings },
              { type: 'separator' as const },
              { label: 'Hide ' + APP_NAME, accelerator: 'Cmd+H', role: 'hide' as const },
              { label: 'Quit ' + APP_NAME, accelerator: 'Cmd+Q', role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        ...(!isMac
          ? [
              { label: 'Settings...', accelerator: 'Ctrl+,', click: openSettings },
              { type: 'separator' as const },
            ]
          : []),
        isMac
          ? { label: 'Close Window', accelerator: 'Cmd+W', role: 'close' as const }
          : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Accelerators set HERE register OS-level handlers on macOS, which
        // intercept the key BEFORE the renderer / xterm.js see it. Only add
        // accelerators for keys we want intercepted globally:
        //   - Cmd+S / Cmd+Shift+S: file-editor save. Save isn't a terminal
        //     key (^S would otherwise fire XOFF / pause output, which we
        //     don't miss). The accelerator routes to FileExplorer's
        //     onEditMenuAction handler — a no-op when no editor is open.
        //   - Cmd+F: editor Find / search panel. Same routing.
        //
        // We deliberately do NOT register Cmd+C / V / X / A / Z here:
        //   - C/V/X/A: terminal selection + paste would break, since the
        //     menu would steal them before xterm.js's key handler runs.
        //   - Z: would steal undo from plain HTML inputs (the global
        //     keydown handler in App.tsx routes Cmd+Z to execCommand
        //     ('undo') for inputs/textareas, which is independent of
        //     CodeMirror's own Cmd+Z keymap).
        // The menu items still work via mouse click; the labels just
        // don't display a keyboard shortcut.
        { label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: canSave, click: () => sendEditAction('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', enabled: hasFile, click: () => sendEditAction('saveAs') },
        { type: 'separator' as const },
        { label: 'Undo', enabled: hasFile, click: () => sendEditAction('undo') },
        { label: 'Redo', enabled: hasFile, click: () => sendEditAction('redo') },
        { type: 'separator' as const },
        { label: 'Cut', enabled: hasFile, click: () => sendEditAction('cut') },
        { label: 'Copy', enabled: hasFile, click: () => sendEditAction('copy') },
        { label: 'Paste', enabled: hasFile, click: () => sendEditAction('paste') },
        { label: 'Select All', enabled: hasFile, click: () => sendEditAction('selectAll') },
        { type: 'separator' as const },
        { label: 'Find / Search…', accelerator: 'CmdOrCtrl+F', enabled: hasFile, click: () => sendEditAction('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Full Screen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11', role: 'togglefullscreen' as const },
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on(IPC_CHANNELS.EDIT_MENU_STATE, (_event, state: EditMenuState) => {
  if (
    editMenuState.hasFile === state.hasFile &&
    editMenuState.canSave === state.canSave
  ) {
    return;
  }
  editMenuState.hasFile = state.hasFile;
  editMenuState.canSave = state.canSave;
  buildMenu();
});

function openSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.SETTINGS_OPEN_DIALOG);
  }
}

const createWindow = () => {
  const iconPath = path.join(app.getAppPath(), 'logo.png');
  const appIcon = nativeImage.createFromPath(iconPath);

  // Set dock icon on macOS
  if (process.platform === 'darwin' && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }

  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: !isMac ? { color: '#1e1e2e', symbolColor: '#cdd6f4', height: 38 } : undefined,
    backgroundColor: '#1e1e2e',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Enables <webview> for the in-app Web tab. Webviews give us a
      // separate process with its own session, so we bypass the
      // X-Frame-Options block that would prevent loading most sites in
      // a plain iframe.
      webviewTag: true,
    },
  });

  setupIpcHandlers(mainWindow);
  buildMenu();

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.on('ready', async () => {
  // Resolve the user's shell PATH/env (zshrc/zshenv etc.) before any PTY
  // spawns — Electron processes get a minimal PATH from launchd otherwise.
  await resolveShellEnv();

  // Handle local-file:// protocol to serve icons from disk
  protocol.handle('local-file', (request) => {
    // Strip query string (used for cache busting) before resolving file path
    const rawPath = request.url.replace('local-file://', '').split('?')[0];
    const filePath = decodeURIComponent(rawPath);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  createWindow();
});

app.on('window-all-closed', () => {
  cleanupIpcHandlers();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  cleanupIpcHandlers();
});
