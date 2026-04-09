# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm start              # Dev mode with hot reload (electron-forge + vite)
npm run package        # Package for current platform
npm run make           # Build distributable (DMG/ZIP/DEB/RPM)
npm run lint           # ESLint across .ts/.tsx files
```

Native module `node-pty` is rebuilt automatically via `@electron-forge/plugin-auto-unpack-natives`. If you get native module errors after switching Node/Electron versions, run `npm start` again — Forge handles the rebuild.

## Architecture

Electron app with strict context isolation. Three process boundaries communicate via IPC:

**Main process** (`src/main.ts` → `src/main/`): Owns all PTY instances and system operations. Never expose Node APIs to the renderer directly.

**Preload** (`src/preload.ts`): Thin bridge exposing `window.api` via `contextBridge`. Every renderer↔main call goes through here. Add new IPC methods in three places: `src/shared/types.ts` (channel constant), `src/main/ipc-handlers.ts` (handler), `src/preload.ts` (bridge).

**Renderer** (`src/renderer.tsx` → `src/renderer/`): React 19 app. Entry point is `index.html → src/renderer.tsx`. Vite bundles this separately with `@vitejs/plugin-react`.

### Terminal Lifecycle (critical path)

PTY creation is **lazy and order-sensitive** — the PTY must not be spawned until the xterm.js Terminal is mounted to a visible DOM element and `fitAddon.fit()` has run. Otherwise the agent starts at wrong dimensions (80x24 default). The sequence in `TerminalPane.tsx`:

1. `createTerminalInstance()` — creates xterm.js Terminal + FitAddon, appends hidden div, does **not** call `terminal.open()`
2. `openTerminal()` — called on first show: `terminal.open(element)`, loads WebGL addon
3. `requestAnimationFrame` → `fitAddon.fit()` → `window.api.createTerminal()` → `resizeTerminal()`

Shell terminals (toggle panel) use the same infrastructure with `shell:{profileId}` IDs and `createShellTerminal` IPC — these skip status detection.

### Status Detection

`StatusDetector` in main process strips ANSI codes from PTY output, keeps a 1000-char rolling buffer, and matches configurable regex patterns with 300ms debounce. Transitions to `ready` or `needs-input` fire OS notifications.

### Profile Config

Profiles stored in `{userData}/profiles.json`. The config loader resolves `~` on load and collapses it back on save. `profiles.example.json` at project root is copied on first run. Profiles are editable via the in-app ProfileEditor modal which writes back through `profiles:save` IPC.

## Vite Config Notes

- `vite.main.config.ts`: Externalizes `node-pty` (native module, can't be bundled)
- `vite.renderer.config.ts`: Loads `@vitejs/plugin-react` for JSX
- `vite.preload.config.ts`: Default config (Vite bundles shared type imports)

## Key Patterns

- `safeSend()` in `ipc-handlers.ts` guards against sending to a destroyed BrowserWindow during shutdown
- `window.api` type declaration lives in `src/renderer/App.tsx` as a global interface augmentation
- The `initialized` Set in App.tsx tracks which profiles have xterm.js instances; `ptyCreated` flag on each TerminalInstance tracks whether the PTY has been spawned
