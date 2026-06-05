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

**Main process** (`src/main.ts` → `src/main/`): Owns all PTY instances, file operations, git status, icon generation, and system operations. Registers a `local-file://` custom protocol for serving local images (icons) to the renderer — strips `?query` params before resolving (used for cache busting). PTY data passes through a coalesce + flow-control pipeline before being shipped to the renderer (see **PTY Output Pipeline** below). Status detection runs on a Node `worker_threads` worker (`src/main/status-worker.ts`) so its regex/ANSI work doesn't block the main event loop.

**Preload** (`src/preload.ts`): Thin bridge exposing `window.api` via `contextBridge`. Uses `webUtils.getPathForFile()` for drag-and-drop file path resolution. Add new IPC methods in four places:

1. `src/shared/types.ts` — channel constant in `IPC_CHANNELS`.
2. `src/main/ipc-handlers.ts` — `ipcMain.handle(...)` or `safeSend(...)` site.
3. `src/preload.ts` — `window.api` bridge function.
4. `src/renderer/App.tsx` — `window.api` type augmentation in the global `Window` interface.

**Renderer** (`src/renderer.tsx` → `src/renderer/`): React 19 app. Entry point is `index.html → src/renderer.tsx`. Vite bundles separately with `@vitejs/plugin-react`.

### Terminal Lifecycle (critical path)

PTY creation is **lazy and order-sensitive** — the PTY must not be spawned until the xterm.js Terminal is mounted to a visible DOM element and `fitAddon.fit()` has run. Otherwise the agent starts at wrong dimensions. The sequence:

1. `createTerminalInstance()` — creates xterm.js Terminal + FitAddon, appends hidden div, does **not** call `terminal.open()`
2. `openTerminal()` — called on first show: `terminal.open(element)`, loads WebGL addon (if GPU acceleration is `auto`), attaches native drop handler
3. `requestAnimationFrame` → `fitAddon.fit()` → `window.api.createTerminal()` → `resizeTerminal()`

**WebGL lifecycle**: Only the active terminal has a WebGL context. Hidden terminals have their WebGL addon disposed to stay within the browser's ~16 context limit. GPU acceleration mode (`auto`/`canvas`/`off`) is configurable in Settings → Appearance. The renderer chosen at terminal-open time is logged to DevTools (`[xterm] renderer=webgl|canvas|dom`).

**Scrollback persistence (shells)**: Shell terminals accumulate output in a per-PTY string buffer (`scrollbackBuffers`, capped at 512 KB) and the renderer can request it back to replay on the next mount. Agent terminals don't currently persist scrollback this way.

**Flow control**: IPC-level back-pressure (256 KB high / 64 KB low watermarks) prevents renderer flooding on fast terminal output. The renderer ACKs only after `terminal.write(data, callback)` reports the parser consumed the bytes — so `flow.pending` reflects real renderer load, not just IPC arrival. When the high watermark is hit, the main process buffers further chunks until the renderer drains below the low watermark.

**Agent args guards** (`src/main/agent-args-guard.ts`): resume-style flags are stripped when the corresponding state directory doesn't exist in the cwd, so the first run of a profile starts fresh instead of erroring.

| Agent | Flag | Required dir |
|---|---|---|
| `claude` | `--continue` | `.claude/` |
| `codex` | `resume` / `--resume` | `.codex/` |
| `gemini` | `resume` / `--resume` | `.gemini/` |
| `opencode` | (no resume flag in default args) | — |

**Hidden state**: When the terminal pane is hidden (README/Files view active), ALL terminal elements are set to `display: none` and no `open()`/`fit()` calls are made. The `hidden` prop controls this. When unhiding, a delayed refit restores correct dimensions. ResizeObservers include a min-dimension guard (10px) to prevent zero-size fits during rapid resizing.

**Drag and drop**: Native DOM `dragenter`/`dragover`/`drop` handlers are attached directly to xterm.js terminal elements via `setupTerminalDrop()`. File paths are resolved with `webUtils.getPathForFile()` and shell-escaped (`escapePathForShell()`) before being sent to the PTY. Both agent and shell terminals support file drops.

### PTY Output Pipeline

PTY → renderer is a multi-stage pipeline tuned to match what VS Code's `TerminalProcess` does:

```
node-pty .onData(string)
   └─ queueData(profileId, data)
       └─ coalesce buffer (5 ms window, 5 KB cap, whichever first)
           └─ processBatch(profileId, data):
               ├─ statusDetector.feedData    (postMessage to worker thread)
               ├─ scrollbackBuffers          (shell terminals only)
               └─ flow control:
                   ├─ TextEncoder.encode → Uint8Array
                   ├─ flow.pending += bytes.byteLength
                   └─ safeSend(TERMINAL_DATA, { profileId, data: Uint8Array })

renderer onTerminalData({ profileId, data: Uint8Array })
   └─ terminal.write(data, () => ackTerminalData(ptyId, len))
                                ↑
                                fires only after xterm parses the chunk
```

Tuning constants (`src/main/ipc-handlers.ts`): `COALESCE_WINDOW_MS = 5`, `COALESCE_MAX_BYTES = 5 * 1024`, `FLOW_HIGH_WATERMARK = 256 * 1024`, `FLOW_LOW_WATERMARK = 64 * 1024`. The smaller byte budget produces more, smaller IPC messages so xterm renders incrementally instead of in visible blocks during heavy bursts.

**Wire format is `Uint8Array`, not string.** `TextEncoder` runs once per coalesced batch in main; xterm consumes bytes natively. Skips Electron's structured-clone path's UTF-16↔UTF-8 round-trip and saves a renderer-side decode. The flow-control accounting uses `byteLength` consistently on both ends.

**Coalesce flush triggers**: 5 ms inactivity timer **or** ≥5 KB accumulated (`flushCoalesced` is called from both paths and on PTY exit, before `clearCoalesced` releases the state).

### Shell Terminals (ShellPane)

`ShellPane.tsx` manages multiple side-by-side shell terminals per profile. Each profile's ShellPane persists across profile switches (rendered in hidden wrappers). Terminal xterm.js instances are recreated when becoming visible (PTY stays alive). Width-resizable splits with visible dividers between panels. Key shortcuts: `Ctrl+Cmd+=` to split, `Ctrl+Cmd+-` to close.

### Status Detection

The `StatusDetector` class in `src/main/status-detector.ts` is a **thin main-thread wrapper** around a worker thread (`src/main/status-worker.ts`, bundled by `vite.worker.config.ts` to `.vite/build/status-worker.js`). All ANSI stripping, regex matching, debounce/idle timers, and per-profile state live in the worker. The wrapper just:

1. Forwards `register` / `unregister` / `feedData` / `setWorking` as `postMessage` to the worker.
2. Maintains a small shadow `Map<profileId, AgentStatus>` so `getStatus` / `getAll` stay synchronous.
3. Forwards `statusChange` messages from the worker to the `onStatusChange` callback.

The worker keeps a 2000-char stripped buffer + 4000-char raw buffer per profile and selects an adapter from the profile's command. **Adapters** (one per built-in agent):

- **`claudeAdapter`** (cmd `claude`): debounce 800 ms, idle 30 s. Working = braille / sparkle spinners (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✶✳✢`) in incoming data. Needs-input = `Allow\s*once`, `Yes.*No.*Always`, `Enter\s*to\s*select`, `Esc\s*to\s*cancel`, etc. Ready = `for\s*shortcuts`, `accept\s*edits`, trailing `❯`.
- **`codexAdapter`** (cmd `codex`): debounce 500 ms, idle 3 s. Working = `esc to interrupt|Escape to cancel|Ctrl+C to stop`. No explicit needs-input pattern (idle timeout handles ready).
- **`geminiAdapter`** (cmd `gemini`): debounce 500 ms, idle 3 s. Working = stripped chunk > 50 chars (Ink TUI streaming heuristic). Needs-input = `Approve?\s*(y/n[/always]?)`.
- **`opencodeAdapter`** (cmd `opencode`): debounce 600 ms, idle 5 s. Working = `esc\s*(to\s*)?interrupt`. Needs-input = `enter\s*submit.*esc\s*dismiss` (multi-choice picker). Ready = `ctrl\+p\s*commands` without an `interrupt` hint.
- **`genericAdapter`** (fallback): conservative 60 s idle, broad pattern set.

**`hasNewContent` filter**: a `working → ready` transition only sets `hasNewContent: true` if the working state lasted ≥ 1500 ms **or** ≥ 4 newlines were committed. This filters resize-redraw and profile-switch flicker.

**Completion confirmation delay (5 s)**: Even when `hasNewContent` is true, the main process holds the bell + OS notification for `COMPLETION_CONFIRMATION_MS = 5000`. If the agent transitions back to `working` (or any non-ready state) during that window, the pending notification is cancelled — protects against false "task completed" pings when Claude briefly idles between turns. The badge color updates immediately (visual feedback stays accurate); the bell fires later via the `PROFILE_COMPLETION_CONFIRMED` IPC channel. `needs-input` bypasses this delay entirely (urgent / user-blocking).

**Notifications**: only fire after the 5 s confirmation for `working→ready`, immediately for `→needs-input`. `offline→ready` suppressed. Skipped when focused on the relevant profile. Include profile icon.

### Built-in Agents

`DEFAULT_AGENTS` in `src/shared/types.ts` ships four entries: **Claude**, **Codex**, **Gemini**, **OpenCode**. Each `AgentConfig` has `id`, `name`, `command`, `args`, and an optional `permissionModeArgs` injected only for parallel (Kanban-dispatched) worktree spawns. Adding a new built-in requires updating four places:

1. `DEFAULT_AGENTS` in `src/shared/types.ts`.
2. A new adapter in `src/main/status-worker.ts` (and route it in `getAdapter()`).
3. Optionally an args guard in `src/main/agent-args-guard.ts` if the agent has resume-style flags.
4. SVG icon entries in `src/renderer/components/{ProfileEditor,ProfileItem,SettingsDialog}.tsx` (each maintains its own `AGENT_ICONS` / `AGENT_ICON_DEFS` map; `stroke?: boolean` flag controls fill-vs-stroke rendering).

`BUILTIN_AGENT_IDS` in `SettingsDialog.tsx` is derived from `DEFAULT_AGENTS`, so step 1 automatically marks the agent as built-in (uneditable command/args in Settings → Agents, but settings still saves user customizations as overrides).

### Theming

`src/renderer/theme.ts` defines Catppuccin Mocha palette as HSL values. `applyTheme()` shifts hues by `baseHue - 240`, scales lightness by `darkness`, overrides text lightness. Value 360 = grayscale. Colors applied as CSS variables (`--c-base`, `--c-mantle`, etc.). Terminal themes generated via `getTerminalTheme()`. Flame settings (intensity, spread, length, speed) also applied as CSS variables (`--flame-intensity`, `--flame-spread`, `--flame-length`, `--flame-speed`).

### Config & Persistence

All in `app.getPath('userData')` (`~/Library/Application Support/Vyb/` — auto-migrated from the legacy `AgentDispatch/` directory on first launch after the rebrand):

- `profiles.json` — profile definitions (tilde-collapsed paths)
- `settings.json` — appearance, fonts, AI keys, external apps, flame settings, pane sizes, nav key, last active profile, GPU acceleration
- `layout.json` — sidebar folder structure and ordering
- `icons/` — generated profile icons

`lastActiveProfileId` in settings restores the selected profile on app launch.

### Profile Editor

`src/renderer/components/ProfileEditor.tsx` — modal for create/edit/delete of agent profiles. Fields: name, working directory, agent (picker), icon (file path or AI-generated), parallel-agent toggle, parallel-agent auto-push toggle.

**Temp scratchpad**: a "Temp" button next to "Browse" calls `window.api.createTempDir()` (IPC `DIALOG_CREATE_TEMP_DIR` → `fs.mkdtempSync(path.join(os.tmpdir(), 'vyb-agent-'))`) which returns a fresh, unique temp folder for short-lived scratchpad agents. Defaults the profile name to "Scratch" if empty.

### Sidebar Layout & Drag-and-Drop

`SidebarLayout`: `items` array (ordered mix of profile/folder refs) + `folders` array. `buildEffectiveLayout()` ensures new profiles appear at bottom, stale refs cleaned. HTML5 DnD with `dragDataRef`. The `inFolderId` param on `handleDrop` enables reordering within folders. `handleDragLeave` checks `relatedTarget` to prevent flicker.

### Keyboard Navigation

`useKeyNav` hook in `KeyNav.tsx` — listens for configurable modifier key (meta/alt). When held: numbered `NavBadge` components appear over command bar buttons, arrow indicators on sidebar and terminal panes. Modifier + number executes action, arrows navigate profiles/panes. `focusedPane` state tracks `{pane: 'agent'|'shell', shellIndex: number}` for cycling through all visible panes.

### Clipboard / Edit-menu roles (focus-aware)

The conflict: on macOS, the standard Edit-menu role items (Copy / Cut / Paste / Select All / Undo / Redo) install OS-level accelerators that intercept Cmd+C/V/X/A *before* the renderer or xterm.js sees them — which breaks terminal copy/paste (xterm's selection isn't a DOM selection the menu can copy). But *without* those roles, plain inputs / Monaco / CodeMirror / Excalidraw lose their clipboard too.

The resolution is **focus-aware menu roles** (`buildMenu` in `src/main.ts`):

- The Edit menu includes the real role items (`{ role: 'copy' }`, etc.), so inputs/Monaco/CodeMirror/Excalidraw get the **OS-default** clipboard for free (no hand-rolled handlers).
- A module-level `terminalFocused` flag **omits those role items entirely whenever the xterm terminal has focus**, so their accelerators aren't registered and the keys reach xterm. The menu is rebuilt on every focus change.
- The renderer reports terminal focus via the `TERMINAL_FOCUS_CHANGED` IPC channel: a `focusin`/`focusout` listener in `App.tsx` checks whether `document.activeElement` is inside `.xterm` and calls `window.api.setTerminalFocused(...)`.
- The terminal's own clipboard handling (`makeTerminalKeyHandler` → `attachCustomKeyEventHandler`, using `navigator.clipboard` + `terminal.getSelection()`) is unchanged; it works because the menu roles are absent while the terminal is focused.

This replaced an earlier approach where the Edit menu omitted the roles and a global `keydown` handler in `App.tsx` (plus per-editor keymaps) reimplemented Cmd+C/V/X/A/Z manually — all of which is now deleted.

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

### Ordna Kanban

`KanbanViewer.tsx` renders Ordna scoped to the active profile's working directory — mirrors the README/Files overlay pattern. Two modes (Settings → Ordna):

- **Web**: main process calls `runWeb({ cwd, port: 0, openBrowser: false })` from `@frehilm/ordna-web`; renderer iframes the resulting `http://127.0.0.1:<port>/` URL.
- **TUI**: spawns `npx -y @frehilm/ordna-cli` via `PtyManager` with PTY id `ordna:<profileId>`. `ordna:` prefix is excluded from status detection.

`OrdnaManager` (`src/main/ordna-manager.ts`) holds at most one running instance and restarts it when the active profile changes. Lifecycle is gated by the renderer: opening the Kanban tab calls `startOrdna()`, closing or unmounting calls `stopOrdna()`.

**Hook receiver**: `ordna-hook-server.ts` runs a tiny HTTP server on `127.0.0.1:<ordnaHookPort>` (9876 by default, falls back to next free port). Validates `X-Token` against `settings.ordnaHookToken` (random hex, generated on first launch). Ordna's outbound POST to `/agent` is forwarded over IPC (`ORDNA_TASK_RECEIVED`) to the renderer, which prepends an instructional context block ("This is a task from the Kanban board… ask clarifying questions…") and writes it into the active agent's PTY via `sendInput`. Env vars `ORDNA_AGENT_HOOK_URL`, `ORDNA_AGENT_HOOK_LABEL`, `ORDNA_AGENT_HOOK_HEADERS` are auto-set when Ordna is launched.

`PtyManager.create()` accepts an optional `extraEnv` param to inject these vars into the spawned PTY environment.

## Vite Config

- `vite.main.config.ts`: Externalizes `node-pty`, `archiver`, `adm-zip`, `@frehilm/ordna-core`, `@frehilm/ordna-web`
- `vite.preload.config.ts`: Default (bundles shared type imports)
- `vite.renderer.config.ts`: `@vitejs/plugin-react` for JSX
- `vite.worker.config.ts`: Builds the status-detection worker (`src/main/status-worker.ts` → `.vite/build/status-worker.js`) as CJS lib mode. Externalizes `worker_threads`. Loaded from main via `new Worker(path.join(__dirname, 'status-worker.js'))`.

The build entries are registered in `forge.config.ts` under `VitePlugin.build[]` (one entry each for main / preload / status-worker). The renderer is registered separately under `VitePlugin.renderer[]`.

## Key Patterns

- `safeSend()` guards against sending to destroyed BrowserWindow during shutdown.
- `window.api` type declaration in `src/renderer/App.tsx` as global interface augmentation.
- `initialized` Set tracks profiles with xterm.js instances; `ptyCreated` flag tracks PTY spawn.
- `hasUpdates` Set tracks profiles with unviewed status transitions — driven by `PROFILE_COMPLETION_CONFIRMED` (delayed 5 s) for completions and `needs-input` immediately.
- `pendingCompletions: Map<profileId, Timeout>` in `ipc-handlers.ts` arbitrates the 5 s confirmation window; cleared on any non-ready transition.
- `coalesceStates: Map<profileId, { pending, flushTimer }>` in `ipc-handlers.ts` is the PTY chunk coalesce buffer.
- `flowStates: Map<profileId, { pending, paused, buffer }>` is the renderer-load back-pressure tracker; `pending` is in UTF-8 bytes.
- Flame indicator: SVG with 13 individual spike paths, color from status, animated via CSS keyframes when working/needs-input, calm breathing when ready.
- Icon bounce animation on profile select (scale + translate + wiggle + motion blur).
- `shellOpenedRef` tracks which profiles have had shell opened (prevents unmount/remount).
- `shellCountRef` tracks shell terminal count for keyboard pane cycling.
- `setupTerminalDrop()` / `escapePathForShell()` — exported from TerminalPane for reuse in ShellPane.
- Global `document.addEventListener('dragover'/'drop', preventDefault)` in App.tsx prevents Electron default file-drop navigation.

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
