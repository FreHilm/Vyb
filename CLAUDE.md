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

**Main process** (`src/main.ts` → `src/main/`): Owns all PTY instances, file operations, git status, icon generation, Slack integration, and system operations. Registers a `local-file://` custom protocol for serving local images (icons) to the renderer — strips `?query` params before resolving (used for cache busting).

**Preload** (`src/preload.ts`): Thin bridge exposing `window.api` via `contextBridge`. Add new IPC methods in four places: `src/shared/types.ts` (channel constant), `src/main/ipc-handlers.ts` (handler), `src/preload.ts` (bridge), `src/renderer/App.tsx` (window.api type).

**Renderer** (`src/renderer.tsx` → `src/renderer/`): React 19 app. Entry point is `index.html → src/renderer.tsx`. Vite bundles separately with `@vitejs/plugin-react`.

### Terminal Lifecycle (critical path)

PTY creation is **lazy and order-sensitive** — the PTY must not be spawned until the xterm.js Terminal is mounted to a visible DOM element and `fitAddon.fit()` has run. Otherwise the agent starts at wrong dimensions. The sequence:

1. `createTerminalInstance()` — creates xterm.js Terminal + FitAddon, appends hidden div, does **not** call `terminal.open()`
2. `openTerminal()` — called on first show: `terminal.open(element)`, loads WebGL addon
3. `requestAnimationFrame` → `fitAddon.fit()` → `window.api.createTerminal()` → `resizeTerminal()`

**Hidden state**: When the terminal pane is hidden (README/Files view active), ALL terminal elements are set to `display: none` and no `open()`/`fit()` calls are made. The `hidden` prop controls this. When unhiding, a delayed refit restores correct dimensions. ResizeObservers include a min-dimension guard (10px) to prevent zero-size fits during rapid resizing.

### Shell Terminals (ShellPane)

`ShellPane.tsx` manages multiple side-by-side shell terminals per profile. Each profile's ShellPane persists across profile switches (rendered in hidden wrappers). Terminal xterm.js instances are recreated when becoming visible (PTY stays alive). Key shortcuts: `Ctrl+Cmd+=` to split, `Ctrl+Cmd+-` to close.

### Status Detection

`StatusDetector` in main process strips ANSI codes incrementally (each chunk before appending), keeps a 2000-char stripped buffer + 4000-char raw buffer. 800ms debounce.

- **Ready**: `for\s*shortcuts` (Claude Code idle hint, spaces may be stripped), `❯` prompt
- **Working**: spinner braille chars (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) checked in raw buffer. Transitions immediately on incoming spinner data without waiting for debounce.
- **Needs-input**: `Allow\s*once`, `Yes.*No.*Always`, etc.
- **Notifications**: only fire on `working→ready` or `→needs-input`. `offline→ready` suppressed. Skipped when focused on active profile. Include profile icon.

### Theming

`src/renderer/theme.ts` defines Catppuccin Mocha palette as HSL values. `applyTheme()` shifts hues by `baseHue - 240`, scales lightness by `darkness`, overrides text lightness. Value 360 = grayscale. Colors applied as CSS variables (`--c-base`, `--c-mantle`, etc.). Terminal themes generated via `getTerminalTheme()`.

### Config & Persistence

All in `app.getPath('userData')` (`~/Library/Application Support/AgentDispatch/`):

- `profiles.json` — profile definitions (tilde-collapsed paths)
- `settings.json` — appearance, fonts, AI keys, external apps, Slack config, pane sizes, nav key
- `layout.json` — sidebar folder structure and ordering
- `icons/` — generated profile icons

### Sidebar Layout & Drag-and-Drop

`SidebarLayout`: `items` array (ordered mix of profile/folder refs) + `folders` array. `buildEffectiveLayout()` ensures new profiles appear at bottom, stale refs cleaned. HTML5 DnD with `dragDataRef`. The `inFolderId` param on `handleDrop` enables reordering within folders. `handleDragLeave` checks `relatedTarget` to prevent flicker.

### Keyboard Navigation

`useKeyNav` hook in `KeyNav.tsx` — listens for configurable modifier key (meta/alt). When held: numbered `NavBadge` components appear over command bar buttons, arrow indicators on sidebar and terminal panes. Modifier + number executes action, arrows navigate profiles/panes. `focusedPane` state tracks `{pane: 'agent'|'shell', shellIndex: number}` for cycling through all visible panes.

### External Applications

Settings → Apps tab. Each app: `name`, `icon` (key from `src/renderer/icons.ts`), `command` (with `{path}` placeholder). Main process runs via `exec()` with `{path}` replaced.

### File Explorer

`FileExplorer.tsx` — CodeMirror 6 editor (left) + lazy-loading file tree (right). Language detection by extension (JS/TS/JSON/CSS/HTML/Python/Markdown). Image files render as `<img>` via `local-file://`. Unsaved changes tracked via `modifiedRef` — dialog on file switch or close. `closeRequested`/`onCloseHandled` pattern for parent-initiated close.

### Icon Generation

Gemini and OpenAI providers. Settings store API keys, model selection, prompt prefix, optional reference image. Reference images sent as `inline_data` (Gemini) or multipart form (OpenAI `/v1/images/edits`). Icons saved to `{userData}/icons/{profileId}.png`. `iconRevision` counter busts browser cache. Batch generation runs in background.

### Slack Integration

`src/main/slack-integration.ts` — `@slack/web-api`. Channel names auto-resolved (searched, joined, or created). Outbound: status posts on `working→ready` and `needs-input` with agent output in code blocks. Inbound: polls channels every 5s, forwards human messages to PTY as `text + \r`. Reinits on settings/profile save.

### Backup

Export: `archiver` creates ZIP of profiles.json, settings.json, layout.json, icons/. Import: `adm-zip` extracts to userData. Both externalized in vite.main.config.ts.

## Vite Config

- `vite.main.config.ts`: Externalizes `node-pty`, `@slack/web-api`, `archiver`, `adm-zip`
- `vite.renderer.config.ts`: `@vitejs/plugin-react` for JSX
- `vite.preload.config.ts`: Default (bundles shared type imports)

## Key Patterns

- `safeSend()` guards against sending to destroyed BrowserWindow during shutdown
- `window.api` type declaration in `src/renderer/App.tsx` as global interface augmentation
- `initialized` Set tracks profiles with xterm.js instances; `ptyCreated` flag tracks PTY spawn
- `hasUpdates` Set tracks profiles with unviewed status transitions — shown as colored highlight
- Flame indicator: SVG with solid base + jagged spike paths, color from status, animated via CSS keyframes when working/needs-input, calm breathing when ready
- Icon bounce animation on profile select (scale + translate + wiggle + motion blur)
- `shellOpenedRef` tracks which profiles have had shell opened (prevents unmount/remount)
- `shellCountRef` tracks shell terminal count for keyboard pane cycling

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
