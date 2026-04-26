import { app, BrowserWindow, Menu, ipcMain, protocol, net, nativeImage } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { setupIpcHandlers, cleanupIpcHandlers } from './main/ipc-handlers';
import { IPC_CHANNELS, EditMenuAction, EditMenuState } from './shared/types';

if (started) {
  app.quit();
}

const APP_NAME = 'AgentDispatch';

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
        { label: 'Save', enabled: canSave, click: () => sendEditAction('save') },
        { label: 'Save As…', enabled: hasFile, click: () => sendEditAction('saveAs') },
        { type: 'separator' as const },
        { label: 'Undo', enabled: hasFile, click: () => sendEditAction('undo') },
        { label: 'Redo', enabled: hasFile, click: () => sendEditAction('redo') },
        { type: 'separator' as const },
        { label: 'Cut', enabled: hasFile, click: () => sendEditAction('cut') },
        { label: 'Copy', enabled: hasFile, click: () => sendEditAction('copy') },
        { label: 'Paste', enabled: hasFile, click: () => sendEditAction('paste') },
        { label: 'Select All', enabled: hasFile, click: () => sendEditAction('selectAll') },
        { type: 'separator' as const },
        { label: 'Find / Search…', enabled: hasFile, click: () => sendEditAction('find') },
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

app.on('ready', () => {
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
