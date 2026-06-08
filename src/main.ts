import { app, BrowserWindow, Menu, ipcMain, protocol, net, nativeImage, shell } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { setupIpcHandlers, cleanupIpcHandlers } from './main/ipc-handlers';
import { resolveShellEnv } from './main/shell-env';
import { startAutoUpdater } from './main/auto-update';
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

// Isolate the dev build's data from the packaged app. Running
// `npm start` and the installed Vyb at the same time would otherwise
// BOTH read/write ~/Library/Application Support/Vyb — and an older
// build (e.g. one predating workspaces) silently drops fields it
// doesn't know about (workspaces[], per-profile workspaceId) when it
// saves, corrupting the packaged app's data. Point dev at a separate
// `Vyb (Dev)` directory so the two never share state. Packaged builds
// are unaffected. Must run before any getPath('userData') read +
// before the legacy migration below.
if (!app.isPackaged) {
  const appDataDir = app.getPath('appData');           // ~/Library/Application Support
  const devDir = path.join(appDataDir, `${APP_NAME} (Dev)`);
  const packagedDir = path.join(appDataDir, APP_NAME);  // the installed app's userData
  try {
    // One-time seed: if the dev dir doesn't have settings yet, copy
    // the packaged app's user data into it so dev starts with the
    // same profiles / workspaces / settings instead of from scratch.
    // After this, the two are fully isolated — edits in dev never
    // touch the packaged data and vice versa. We copy only user-data
    // files, NOT Electron's Cache/Cookies/IndexedDB/etc. (those hold
    // locks + partition state that shouldn't be shared).
    const alreadySeeded = fs.existsSync(path.join(devDir, 'settings.json'));
    fs.mkdirSync(devDir, { recursive: true });
    if (!alreadySeeded && fs.existsSync(path.join(packagedDir, 'settings.json'))) {
      const seedItems = [
        'settings.json', 'profiles.json', 'layout.json', 'profile-memory.json',
        'icons', 'parallel-agents', 'terminal-states', 'scrollback',
      ];
      let seeded = 0;
      for (const name of seedItems) {
        const src = path.join(packagedDir, name);
        const dst = path.join(devDir, name);
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        try {
          fs.cpSync(src, dst, { recursive: true });
          seeded++;
        } catch (e) {
          console.error(`[Vyb] dev seed: failed to copy ${name}:`, e);
        }
      }
      console.log(`[Vyb] dev mode — seeded ${seeded} item(s) from ${packagedDir}`);
    }
    app.setPath('userData', devDir);
    console.log(`[Vyb] dev mode — using isolated userData: ${devDir}`);
  } catch (err) {
    console.error('[Vyb] failed to set dev userData dir:', err);
  }
}

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

// True while the xterm terminal has keyboard focus. When focused we OMIT the
// native clipboard roles from the Edit menu, because their accelerators
// (Cmd+C/V/X/A) get consumed at the menu level before xterm.js's own key
// handler can run — which would break terminal copy/paste/select. When the
// terminal is NOT focused, the roles are present so inputs / Monaco /
// CodeMirror / Excalidraw get the OS-default clipboard for free.
let terminalFocused = false;

function sendEditAction(action: EditMenuAction) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.EDIT_MENU_ACTION, action);
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // Menu role items (copy/paste/undo/selectAll) install OS-level accelerators
  // that intercept Cmd+C/V/X/A before the renderer/xterm.js see them. We WANT
  // that for inputs/Monaco/CodeMirror/Excalidraw (free OS clipboard), but it
  // breaks the terminal — so the Edit menu's clipboard roles are dropped while
  // the terminal is focused (`terminalFocused`, toggled via the
  // TERMINAL_FOCUS_CHANGED IPC; menu rebuilt on each change). Save / Find stay
  // as click+IPC items (Cmd+S/Cmd+F aren't terminal keys we need).
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
        { label: 'New Project Profile', accelerator: 'CmdOrCtrl+N', click: newProfile },
        { type: 'separator' as const },
        // Save / Save As route to the file editor via IPC, enabled only when
        // a file is open / modified. Cmd+S/Cmd+Shift+S are safe to register
        // globally (not terminal keys we need; the handler no-ops with no editor).
        { label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: canSave, click: () => sendEditAction('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', enabled: hasFile, click: () => sendEditAction('saveAs') },
        { type: 'separator' as const },
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
        // Native clipboard roles (Cmd+Z/X/C/V/A). Their accelerators are
        // registered at the OS level, which is exactly what gives plain
        // inputs / Monaco / CodeMirror / Excalidraw working copy-paste for
        // free — BUT it also swallows the key before xterm.js. So we drop
        // these entirely while the terminal is focused (see terminalFocused),
        // letting xterm's own handler own Cmd+C/V/X/A there. The menu is
        // rebuilt on every terminal focus change.
        ...(terminalFocused
          ? []
          : [
              { role: 'undo' as const },
              { role: 'redo' as const },
              { type: 'separator' as const },
              { role: 'cut' as const },
              { role: 'copy' as const },
              { role: 'paste' as const },
              { role: 'selectAll' as const },
              { type: 'separator' as const },
            ]),
        // Editor functions — routed to the file editor via IPC, enabled only
        // while a file is open. Accelerators are safe to register globally
        // (the handler no-ops when no editor is open). Save / Save As now
        // live in the File menu.
        { label: 'Find & Replace…', accelerator: 'CmdOrCtrl+Alt+F', enabled: hasFile, click: () => sendEditAction('find') },
        { label: 'Format Document', accelerator: 'Shift+Alt+F', enabled: hasFile, click: () => sendEditAction('format') },
        { label: 'Reveal in File Tree', accelerator: 'CmdOrCtrl+Shift+E', enabled: hasFile, click: () => sendEditAction('reveal') },
        { label: 'Toggle Blame', enabled: hasFile, click: () => sendEditAction('blame') },
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

ipcMain.on(IPC_CHANNELS.TERMINAL_FOCUS_CHANGED, (_event, focused: boolean) => {
  if (focused === terminalFocused) return;
  terminalFocused = focused;
  buildMenu(); // re-include / drop the clipboard roles
});

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

// Windows/Linux use a custom (hidden) title bar, so Electron never draws a
// native menu bar — the menu set by buildMenu() exists but is invisible. The
// renderer title bar renders File/Edit/View buttons and asks us to pop up the
// matching top-level submenu at the button's location, reusing the exact same
// (live, correctly-enabled) menu items the macOS menu bar uses.
ipcMain.on(
  IPC_CHANNELS.MENU_POPUP,
  (_event, payload: { label: string; x: number; y: number }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const appMenu = Menu.getApplicationMenu();
    const item = appMenu?.items.find((i) => i.label === payload.label);
    if (item?.submenu) {
      item.submenu.popup({
        window: mainWindow,
        x: Math.round(payload.x),
        y: Math.round(payload.y),
      });
    }
  },
);

// Recolor the native window-control overlay (Windows/Linux) to match the
// renderer's current theme. macOS uses 'hiddenInset' with no overlay, so
// setTitleBarOverlay would throw there — skip it.
ipcMain.on(
  IPC_CHANNELS.TITLEBAR_SET_OVERLAY,
  (_event, payload: { color: string; symbolColor: string }) => {
    if (process.platform === 'darwin') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setTitleBarOverlay({
        color: payload.color,
        symbolColor: payload.symbolColor,
      });
    } catch { /* overlay unsupported on this platform/config */ }
  },
);

function openSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.SETTINGS_OPEN_DIALOG);
  }
}

function newProfile() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.MENU_NEW_PROFILE);
  }
}

const createWindow = () => {
  // Defensive: a BrowserWindow can only be created once the app is ready.
  // Any caller that runs earlier (e.g. an early `activate` on macOS) would
  // crash the main process. Bail — the `ready` handler always creates the
  // initial window, so no caller needs to create one before then.
  if (!app.isReady()) return;

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
    // Neutral grey defaults to avoid a purple flash before the renderer
    // recolors the overlay to the live theme (TITLEBAR_SET_OVERLAY). The app's
    // text is always grayscale, so grey symbols match every theme's steady
    // state; the renderer fine-tunes the background tint on first paint.
    titleBarOverlay: !isMac ? { color: '#1e1e1e', symbolColor: '#cdcdcd', height: 38 } : undefined,
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

  // Intercept the window close (red traffic-light / Cmd+W path) so the
  // unsaved-files check runs before the renderer is torn down. Cmd+Q goes
  // through before-quit instead; both funnel through the same handshake via
  // `unsavedConfirmed`. Once confirmed (or already quitting) we let it close.
  mainWindow.on('close', (e) => {
    if (quitHandled || unsavedConfirmed) return;
    if (requestUnsavedCheck()) e.preventDefault();
  });

  // Defensive guard: block any top-level navigation away from the app
  // shell. A stray `<a href="other.md">` click in any future markdown
  // / html render that forgets to call e.preventDefault() would
  // otherwise replace the entire renderer with a raw file:// page and
  // destroy the React tree. The renderer's own handlers route legit
  // link clicks (`open-file-in-explorer`, `openUrl`) before this
  // would ever fire; this is a last-resort safety net.
  const initialUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? '';
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (initialUrl && url.startsWith(initialUrl)) return; // dev-server HMR
    event.preventDefault();
    // Soft fallback: relative or file URLs probably wanted to go to
    // the file viewer; everything else opens in the OS browser. This
    // matches the renderer's intentional routing for the cases the
    // handler does catch.
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch((): void => undefined);
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// Cmd+C / Cmd+V / Cmd+X / Cmd+A / Cmd+Z inside the in-app browser
// (`<webview>`). The host Edit menu deliberately omits Cocoa-role
// accelerators (they would intercept Cmd+C before xterm.js could
// handle it), but the inner webview is its own Chromium renderer and
// also needs those accelerators — so we re-bind here on the
// webview's webContents via `before-input-event`. The host renderer
// never sees these keystrokes (focus is fully inside the webview), so
// this main-process listener is the only place that can intercept.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === 'c') contents.copy();
    else if (key === 'v') contents.paste();
    else if (key === 'x') contents.cut();
    else if (key === 'a') contents.selectAll();
    else if (key === 'z') input.shift ? contents.redo() : contents.undo();
    else return;
    event.preventDefault();
  });
});

app.on('ready', async () => {
  // Resolve the user's shell PATH/env (zshrc/zshenv etc.) before any PTY
  // spawns — Electron processes get a minimal PATH from launchd otherwise.
  await resolveShellEnv();

  // Kick off the auto-updater. No-ops in dev (unpackaged) builds.
  startAutoUpdater();

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
  app.quit();
});

app.on('activate', () => {
  // macOS can emit `activate` BEFORE `ready` on launch/relaunch (notably
  // after an auto-update relaunch). Calling new BrowserWindow() before the
  // app is ready throws "Cannot create BrowserWindow before app is ready"
  // and crashes the main process. The `ready` handler always creates the
  // initial window, so just bail here until the app is actually ready.
  if (!app.isReady()) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Quit teardown. node-pty kills its PTYs synchronously but its
// per-PTY exit watcher fires the exit callback ASYNCHRONOUSLY on a
// worker thread (via a napi ThreadSafeFunction). If we let Electron
// proceed straight into Node's graceful environment teardown, that
// exit callback races the teardown and calls back into a
// half-destroyed JS context — napi then throws with no handler and
// the process aborts (SIGABRT in pty.node on quit). To avoid it we
// run cleanup (which kills the PTYs), defer the real quit one tick so
// those exit callbacks drain while JS is still alive, then quit for
// real. `quitHandled` guards against re-entrancy on the second quit.
let quitHandled = false;
// Set once the renderer has confirmed it's OK to quit (no unsaved files, or
// the user chose Save all / Discard). Until then, a quit is intercepted and
// the renderer is asked to run its unsaved-files check + dialog.
let unsavedConfirmed = false;
let quitDecisionPending = false;

function proceedWithQuit(): void {
  quitHandled = true;
  cleanupIpcHandlers();
  // 200 ms is comfortably longer than the kill→exit-callback latency
  // (a killed child's kevent wakes within a few ms) while staying
  // imperceptible to the user closing the app.
  setTimeout(() => app.quit(), 200);
}

// Ask the renderer to run its unsaved-files check. Returns true if it took
// over (caller should abort the close/quit and wait for APP_QUIT_DECISION),
// false if there's no renderer to ask (caller should just proceed).
function requestUnsavedCheck(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!quitDecisionPending) {
    quitDecisionPending = true;
    mainWindow.webContents.send(IPC_CHANNELS.APP_BEFORE_QUIT);
    // Safety net: if the renderer never replies (e.g. it crashed mid-dialog),
    // don't trap the user in an unclosable app.
    setTimeout(() => {
      if (!unsavedConfirmed && quitDecisionPending) {
        unsavedConfirmed = true;
        app.quit();
      }
    }, 15000);
  }
  return true;
}

// Renderer's verdict from the unsaved-files dialog.
ipcMain.on(IPC_CHANNELS.APP_QUIT_DECISION, (_e, proceed: boolean) => {
  quitDecisionPending = false;
  if (!proceed) return; // user cancelled — stay open; next quit re-asks.
  unsavedConfirmed = true;
  app.quit(); // re-enters before-quit, now confirmed → proceedWithQuit().
});

app.on('before-quit', (event) => {
  if (quitHandled) return;
  event.preventDefault();
  if (!unsavedConfirmed) {
    if (!requestUnsavedCheck()) {
      unsavedConfirmed = true;
      proceedWithQuit();
    }
    return;
  }
  proceedWithQuit();
});
