# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm start              # Dev mode with hot reload (electron-forge + vite)
npm run package        # Package for current platform
npm run make           # Build distributable (DMG/ZIP/DEB/RPM)
npm run lint           # ESLint across .ts/.tsx files
```

Requires Node 24+ LTS (use `nvm use 24`). Native module `node-pty` is rebuilt automatically via `@electron-forge/plugin-auto-unpack-natives`. The `postinstall` script patches the Electron binary's Info.plist and icon for macOS dev mode.

## Architecture

Electron app with strict context isolation. Three process boundaries communicate via IPC:

**Main process** (`src/main.ts` → `src/main/`): Owns all PTY instances, file operations, git status, icon generation, and system operations. Registers a `local-file://` custom protocol for serving local images (icons) to the renderer — strips `?query` params before resolving (used for cache busting). Runs headless xterm.js replay buffers (`TerminalBackend`) for terminal state serialization.

**Preload** (`src/preload.ts`): Thin bridge exposing `window.api` via `contextBridge`. Uses `webUtils.getPathForFile()` for drag-and-drop file path resolution. Add new IPC methods in four places: `src/shared/types.ts` (channel constant), `src/main/ipc-handlers.ts` (handler), `src/preload.ts` (bridge), `src/renderer/App.tsx` (window.api type).

**Renderer** (`src/renderer.tsx` → `src/renderer/`): React 19 app. Entry point is `index.html → src/renderer.tsx`. Vite bundles separately with `@vitejs/plugin-react`.

### Terminal Lifecycle (critical path)

PTY creation is **lazy and order-sensitive** — the PTY must not be spawned until the xterm.js Terminal is mounted to a visible DOM element and `fitAddon.fit()` has run. Otherwise the agent starts at wrong dimensions. The sequence:

1. `createTerminalInstance()` — creates xterm.js Terminal + FitAddon, appends hidden div, does **not** call `terminal.open()`
2. `openTerminal()` — called on first show: `terminal.open(element)`, loads WebGL addon (if GPU acceleration is `auto`), attaches native drop handler
3. `requestAnimationFrame` → `fitAddon.fit()` → `window.api.createTerminal()` → `resizeTerminal()`

**WebGL lifecycle**: Only the active terminal has a WebGL context. Hidden terminals have their WebGL addon disposed to stay within the browser's ~16 context limit. GPU acceleration mode (`auto`/`canvas`/`off`) is configurable in Settings → Appearance.

**Terminal replay**: Headless xterm.js instances in `TerminalBackend` (main process) mirror all PTY output. When switching profiles, the renderer requests serialized state via `serializeTerminal()` and replays it — preserving scrollback, colors, and cursor position.

**Flow control**: IPC-level back-pressure (256KB high / 64KB low watermarks) prevents renderer flooding on fast terminal output. Renderer sends `TERMINAL_ACK` after processing data.

**`--continue` guard**: When the command is `claude` with `--continue`, the main process checks for a `.claude/` folder in the working directory. If absent, `--continue` is stripped so Claude starts fresh.

**Hidden state**: When the terminal pane is hidden (README/Files view active), ALL terminal elements are set to `display: none` and no `open()`/`fit()` calls are made. The `hidden` prop controls this. When unhiding, a delayed refit restores correct dimensions. ResizeObservers include a min-dimension guard (10px) to prevent zero-size fits during rapid resizing.

**Drag and drop**: Native DOM `dragenter`/`dragover`/`drop` handlers are attached directly to xterm.js terminal elements via `setupTerminalDrop()`. File paths are resolved with `webUtils.getPathForFile()` and shell-escaped (`escapePathForShell()`) before being sent to the PTY. Both agent and shell terminals support file drops.

### Shell Terminals (ShellPane)

`ShellPane.tsx` manages multiple side-by-side shell terminals per profile. Each profile's ShellPane persists across profile switches (rendered in hidden wrappers). Terminal xterm.js instances are recreated when becoming visible (PTY stays alive). Width-resizable splits with visible dividers between panels. Key shortcuts: `Ctrl+Cmd+=` to split, `Ctrl+Cmd+-` to close.

### Status Detection

`StatusDetector` in main process strips ANSI codes incrementally (each chunk before appending), keeps a 2000-char stripped buffer + 4000-char raw buffer. 800ms debounce.

- **Ready**: `for\s*shortcuts` (Claude Code idle hint, spaces may be stripped), `❯` prompt
- **Working**: spinner braille chars (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) checked in raw buffer. Transitions immediately on incoming spinner data without waiting for debounce.
- **Needs-input**: `Allow\s*once`, `Yes.*No.*Always`, etc.
- **Notifications**: only fire on `working→ready` or `→needs-input`. `offline→ready` suppressed. Skipped when focused on active profile. Include profile icon.

### Theming

`src/renderer/theme.ts` defines Catppuccin Mocha palette as HSL values. `applyTheme()` shifts hues by `baseHue - 240`, scales lightness by `darkness`, overrides text lightness. Value 360 = grayscale. Colors applied as CSS variables (`--c-base`, `--c-mantle`, etc.). Terminal themes generated via `getTerminalTheme()`. Flame settings (intensity, spread, length, speed) also applied as CSS variables (`--flame-intensity`, `--flame-spread`, `--flame-length`, `--flame-speed`).

### Config & Persistence

All in `app.getPath('userData')` (`~/Library/Application Support/AgentDispatch/`):

- `profiles.json` — profile definitions (tilde-collapsed paths)
- `settings.json` — appearance, fonts, AI keys, external apps, flame settings, pane sizes, nav key, last active profile, GPU acceleration
- `layout.json` — sidebar folder structure and ordering
- `icons/` — generated profile icons

`lastActiveProfileId` in settings restores the selected profile on app launch.

### Sidebar Layout & Drag-and-Drop

`SidebarLayout`: `items` array (ordered mix of profile/folder refs) + `folders` array. `buildEffectiveLayout()` ensures new profiles appear at bottom, stale refs cleaned. HTML5 DnD with `dragDataRef`. The `inFolderId` param on `handleDrop` enables reordering within folders. `handleDragLeave` checks `relatedTarget` to prevent flicker.

### Keyboard Navigation

`useKeyNav` hook in `KeyNav.tsx` — listens for configurable modifier key (meta/alt). When held: numbered `NavBadge` components appear over command bar buttons, arrow indicators on sidebar and terminal panes. Modifier + number executes action, arrows navigate profiles/panes. `focusedPane` state tracks `{pane: 'agent'|'shell', shellIndex: number}` for cycling through all visible panes.

### External Applications

Settings → Apps tab. Each app: `name`, `icon` (key from `src/renderer/icons.ts`), `command` (with `{path}` placeholder). Main process runs via `exec()` with `{path}` replaced.

### File Explorer

`FileExplorer.tsx` — tabbed CodeMirror 6 editor (left) + resizable lazy-loading file tree (right).

**Tab system**: Multiple files open as tabs. `*` on tab name indicates unsaved changes. Clicking a file in the tree reuses the active tab unless it has modifications (then opens a new tab). "Open in New Tab" available in context menu. Closing a modified tab triggers Save/Discard/Cancel dialog. Editor content cached per tab in `docCacheRef` and restored on tab switch.

**Save/Save As**: Buttons in tab bar, only visible for non-image files. Save only enabled when file is modified. Save As opens native OS dialog. Keyboard: `Cmd+S` save, `Cmd+Shift+S` save as.

**File icons**: `src/renderer/file-icons.tsx` — inline 16x16 SVG icons mapped by extension (JS, TS, JSON, CSS, HTML, Python, Markdown, images, shell, config, etc.) and special filenames (package.json, tsconfig.json, Dockerfile, README.md). Folders use amber color.

**File operations**: Right-click context menu with Copy, Paste, Delete (confirmation dialog), Rename (inline input), New File, New Folder. Tree header has New File/Folder buttons. IPC channels: `FILE_DELETE`, `FILE_RENAME`, `FILE_COPY`, `FILE_CREATE_DIR`, `FILE_CREATE`, `FILE_SAVE_AS`.

Language detection by extension (JS/TS/JSON/CSS/HTML/Python/Markdown). Image files render as `<img>` via `local-file://`.

### Flame Indicators

13 individual spike triangles with independent animation timing/delays for organic randomness. Configurable via Settings → Flames: intensity (opacity), spread (horizontal scale), length (zone width), speed (animation pace). CSS variables `--flame-intensity`, `--flame-spread`, `--flame-length`, `--flame-speed` control the rendering. Live preview in settings shows Working, Ready, and Needs Input states.

### Icon Generation

Gemini and OpenAI providers. Settings store API keys, model selection, prompt prefix, optional reference image. Reference images sent as `inline_data` (Gemini) or multipart form (OpenAI `/v1/images/edits`). Icons saved to `{userData}/icons/{profileId}.png`. `iconRevision` counter busts browser cache. Batch generation runs in background.

### Backup

Export: `archiver` creates ZIP of profiles.json, settings.json, layout.json, icons/. Import: `adm-zip` extracts to userData. Both externalized in vite.main.config.ts.

### Git Status Bar

`StatusBar.tsx` polls git status every 10s (local only). Shows branch, staged/modified/untracked counts, ahead/behind, stashes, last commit, remote link. Fetch button runs `git fetch --quiet` on demand and refreshes status.

## Vite Config

- `vite.main.config.ts`: Externalizes `node-pty`, `archiver`, `adm-zip`, `@xterm/xterm`, `@xterm/addon-serialize`
- `vite.renderer.config.ts`: `@vitejs/plugin-react` for JSX
- `vite.preload.config.ts`: Default (bundles shared type imports)

## Key Patterns

- `safeSend()` guards against sending to destroyed BrowserWindow during shutdown
- `window.api` type declaration in `src/renderer/App.tsx` as global interface augmentation
- `initialized` Set tracks profiles with xterm.js instances; `ptyCreated` flag tracks PTY spawn
- `hasUpdates` Set tracks profiles with unviewed status transitions — shown as colored highlight
- Flame indicator: SVG with 13 individual spike paths, color from status, animated via CSS keyframes when working/needs-input, calm breathing when ready
- Icon bounce animation on profile select (scale + translate + wiggle + motion blur)
- `shellOpenedRef` tracks which profiles have had shell opened (prevents unmount/remount)
- `shellCountRef` tracks shell terminal count for keyboard pane cycling
- `setupTerminalDrop()` / `escapePathForShell()` — exported from TerminalPane for reuse in ShellPane
- Global `document.addEventListener('dragover'/'drop', preventDefault)` in App.tsx prevents Electron default file-drop navigation

## Dependencies & Licensing

This project is MIT-licensed. All dependencies must use compatible permissive licenses. When adding a new npm package:

1. Check its license before installing — only **MIT**, **ISC**, **Apache-2.0**, **BSD-2-Clause**, **BSD-3-Clause**, and **0BSD** are allowed.
2. **Never** add packages with copyleft licenses (GPL, LGPL, AGPL, MPL) — these would force the entire app to adopt that license.
3. After adding a new runtime dependency, update `THIRD_PARTY_NOTICES.md` with the package name, license, and description.
4. Dev-only dependencies (build tools, linters, types) are less restrictive but should still avoid copyleft.

To verify: `npm view <package> license` before installing.

## Cross-Platform

~90% portable. Key platform-specific code:
- Title bar: `hiddenInset` on macOS, `hidden` + `titleBarOverlay` on Windows/Linux
- Fork button hidden on Linux (`window.api.platform` check)
- `app.dock` uses optional chaining (macOS-only)
- External app commands are user-configurable per platform
- Postinstall patches macOS plist + icon (try-caught, harmless on other platforms)
