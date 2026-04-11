# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm start              # Dev mode with hot reload (electron-forge + vite)
npm run package        # Package for current platform
npm run make           # Build distributable (DMG/ZIP/DEB/RPM)
npm run lint           # ESLint across .ts/.tsx files
```

Native module `node-pty` is rebuilt automatically via `@electron-forge/plugin-auto-unpack-natives`. The `postinstall` script patches the Electron binary's Info.plist and icon for macOS dev mode (app name + icon in dock/menu bar).

## Architecture

Electron app with strict context isolation. Three process boundaries communicate via IPC:

**Main process** (`src/main.ts` → `src/main/`): Owns all PTY instances, file operations, git status, icon generation, and system operations. Never expose Node APIs to the renderer directly. Registers a `local-file://` custom protocol for serving local images (icons) to the renderer.

**Preload** (`src/preload.ts`): Thin bridge exposing `window.api` via `contextBridge`. Every renderer↔main call goes through here. Add new IPC methods in three places: `src/shared/types.ts` (channel constant), `src/main/ipc-handlers.ts` (handler), `src/preload.ts` (bridge), and update the `window.api` type in `src/renderer/App.tsx`.

**Renderer** (`src/renderer.tsx` → `src/renderer/`): React 19 app. Entry point is `index.html → src/renderer.tsx`. Vite bundles this separately with `@vitejs/plugin-react`.

### Terminal Lifecycle (critical path)

PTY creation is **lazy and order-sensitive** — the PTY must not be spawned until the xterm.js Terminal is mounted to a visible DOM element and `fitAddon.fit()` has run. Otherwise the agent starts at wrong dimensions (80x24 default). The sequence in `TerminalPane.tsx`:

1. `createTerminalInstance()` — creates xterm.js Terminal + FitAddon, appends hidden div, does **not** call `terminal.open()`
2. `openTerminal()` — called on first show: `terminal.open(element)`, loads WebGL addon
3. `requestAnimationFrame` → `fitAddon.fit()` → `window.api.createTerminal()` → `resizeTerminal()`

Shell terminals (toggle panel) use the same infrastructure with `shell:{profileId}` IDs and `createShellTerminal` IPC — these skip status detection.

**Hidden state**: When the terminal pane is hidden (README or Files view active), ALL terminal elements are set to `display: none` and no `open()`/`fit()` calls are made. The `hidden` prop on TerminalPane controls this. When unhiding, a delayed refit effect restores correct dimensions.

### Status Detection

`StatusDetector` in main process strips ANSI codes from PTY output incrementally (strip each chunk before appending to buffer), keeps a 2000-char stripped buffer + 4000-char raw buffer. Matches configurable regex patterns with 800ms debounce.

- **Ready**: detected by `for\s*shortcuts` (Claude Code idle hint, spaces may be stripped) and `❯` prompt
- **Working**: detected by spinner braille characters (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) checked in raw buffer. Also transitions immediately on incoming spinner data without waiting for debounce.
- **Needs-input**: permission prompts like `Allow\s*once`, `Yes.*No.*Always`, etc.
- **Notifications**: only fire on `working→ready` or `→needs-input` transitions. `offline→ready` (initial load) is suppressed. Skipped when the window is focused on the active profile.

### Theming

`src/renderer/theme.ts` defines the Catppuccin Mocha palette as HSL values. `applyTheme()` shifts all hues by `baseHue - 240`, scales lightness by `darkness`, and overrides text lightness with `textLightness`. Colors are applied as CSS custom properties (`--c-base`, `--c-mantle`, etc.) on `:root`. Terminal themes are generated via `getTerminalTheme()` and applied to xterm.js instances. Value 360 for `baseHue` = grayscale (saturation zeroed).

### Config & Persistence

All stored in `app.getPath('userData')` (`~/Library/Application Support/Power Agent Command Center/`):

- `profiles.json` — profile definitions (tilde-collapsed paths)
- `settings.json` — appearance, font sizes, AI keys, external apps, pane sizes
- `layout.json` — sidebar folder structure and ordering
- `icons/` — generated profile icons

### Sidebar Layout

`SidebarLayout` in types.ts: `items` array (ordered mix of `{type:'profile'}` and `{type:'folder'}`) + `folders` array. `buildEffectiveLayout()` in Sidebar.tsx ensures new profiles not in layout appear at bottom and stale references are cleaned. Drag-and-drop uses HTML5 DnD API with `dragDataRef` to track what's being dragged. The `inFolderId` parameter on `handleDrop` enables reordering within folders.

### External Applications

Configurable in Settings → Applications tab. Each app has `name`, `icon` (key from `src/renderer/icons.ts` icon set), and `command` (shell command with `{path}` placeholder). The main process runs the command via `exec()` with `{path}` replaced by the profile's working directory.

### File Explorer

`FileExplorer.tsx` — CodeMirror 6 editor (left) + file tree (right). Language detection by extension. Image files render as `<img>` via `local-file://` protocol. Unsaved changes tracked via `modifiedRef` — dialog shown on file switch or close. `closeRequested`/`onCloseHandled` pattern lets App.tsx request close while FileExplorer handles the save dialog.

### Icon Generation

Supports Gemini and OpenAI providers. Settings store API keys, model selection, prompt prefix, and optional reference image. Reference images are sent as `inline_data` (Gemini) or multipart form `image` field (OpenAI `/v1/images/edits`). Generated icons saved to `{userData}/icons/{profileId}.png`. `iconRevision` counter in App.tsx busts browser cache on regeneration.

## Vite Config Notes

- `vite.main.config.ts`: Externalizes `node-pty` (native module, can't be bundled)
- `vite.renderer.config.ts`: Loads `@vitejs/plugin-react` for JSX
- `vite.preload.config.ts`: Default config (Vite bundles shared type imports)

## Key Patterns

- `safeSend()` in `ipc-handlers.ts` guards against sending to a destroyed BrowserWindow during shutdown
- `window.api` type declaration lives in `src/renderer/App.tsx` as a global interface augmentation
- The `initialized` Set in App.tsx tracks which profiles have xterm.js instances; `ptyCreated` flag on each TerminalInstance tracks whether the PTY has been spawned
- `hasUpdates` Set tracks profiles with completed/needs-input transitions that haven't been viewed yet — shown as colored highlight on profile items
- Flame indicator on active profile: SVG with solid base bar + flame paths, color from status, animated via CSS when `working` or `needs-input`
- `local-file://` protocol strips `?query` params before resolving (used for cache busting)

## Cross-Platform

The app is ~90% portable. Key platform-specific code:
- Title bar: `hiddenInset` on macOS, `hidden` + `titleBarOverlay` on Windows/Linux (`src/main.ts`)
- Fork button hidden on Linux (`window.api.platform` check in CommandBar)
- `app.dock` calls use optional chaining (macOS-only, no-op elsewhere)
- External app commands are user-configurable, so users set platform-appropriate commands
