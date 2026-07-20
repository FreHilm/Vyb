# Architecture

Vyb is an Electron app built around the framework's recommended security model: strict context isolation, no Node integration in the renderer, and a thin `contextBridge` between the two. There are three process boundaries.

```
┌──────────────────────────────────────────────────────────┐
│  Main process  (src/main.ts → src/main/)                  │
│  ├── PtyManager        — owns every PTY instance          │
│  ├── StatusDetector    — thin wrapper over…               │
│  ├── status-worker.ts  — worker thread: ANSI strip +      │
│  │                       per-agent status adapters        │
│  ├── ipc-handlers.ts   — all IPC + profile/settings I/O   │
│  ├── ordna-manager.ts  — Kanban (Ordna) lifecycle         │
│  ├── telegram-transport.ts — remote-agent chat (GramJS)   │
│  └── auto-update.ts    — electron-updater wiring          │
├──────────────────────────────────────────────────────────┤
│  Preload  (src/preload.ts)                                │
│  └── contextBridge → exposes a typed `window.api`         │
├──────────────────────────────────────────────────────────┤
│  Renderer  (src/renderer/, React 19)                      │
│  ├── App.tsx           — root state & routing             │
│  ├── Sidebar           — profiles, folders, workspaces    │
│  ├── TerminalPane      — agent terminals (xterm.js)       │
│  ├── ShellPane         — splittable shell terminals       │
│  ├── CommandBar        — quick-action buttons + nav       │
│  ├── FileExplorer      — file tree + Monaco editor + diff │
│  ├── GitChangesPanel   — stage / commit / branches /      │
│  │                       conflict & 3-way merge resolver  │
│  ├── WebViewer         — embedded browser + DevTools      │
│  ├── KanbanViewer      — Ordna integration                │
│  ├── RemoteChatPane    — Telegram remote-agent chat       │
│  ├── ReadmeViewer      — markdown + Mermaid               │
│  ├── StatusBar         — git status & remote link         │
│  ├── SettingsDialog    — tabbed settings                  │
│  ├── ProfileEditor     — profile CRUD + icon generation   │
│  └── KeyNav            — keyboard navigation system       │
└──────────────────────────────────────────────────────────┘
```

The **main process** owns everything privileged: it spawns and manages all PTYs, reads and writes config, talks to git, generates icons, and runs system operations. The **renderer** never sees `require` or Node APIs — it only has the `window.api` surface the preload exposes.

## How agents run

Each profile maps to a PTY (`node-pty`) spawned by `PtyManager`. PTY creation is deliberately lazy and order-sensitive: the PTY isn't spawned until the xterm.js terminal is mounted to a visible element and sized, so the agent never starts at the wrong dimensions.

PTY output flows to the renderer through a tuned pipeline — coalesced into small batches, analyzed for status on a worker thread, and shipped with IPC-level flow control so a fast-talking agent can't flood the renderer. The wire format is raw bytes (`Uint8Array`), which xterm.js consumes natively and which skips a UTF-16↔UTF-8 round-trip.

## Remote agents

A profile can bind to a **remote agent** instead of a local command — currently an agent (such as a Hermes gateway) reached through its Telegram bot. For these profiles no PTY is spawned: the agent pane renders a chat view (`RemoteChatPane`) driven by `telegram-transport.ts` in the main process, a GramJS (MTProto) client signed into the user's own Telegram account. Gateways stream replies by editing the bot message in place; the transport forwards new-message and edit events to the renderer and synthesizes *working*/*ready* status from the stream (a turn counts as done after the edits settle), so remote agents light up the sidebar flames and notifications exactly like PTY agents.

## Status detection

Knowing whether an agent is *working*, *ready*, or *waiting for input* is the heart of the app, and it runs on a dedicated **worker thread** (`status-worker.ts`) so its regex and ANSI-stripping work never blocks the UI. Each built-in agent has its own adapter tuned to that tool's output (spinner glyphs, prompt patterns, idle timeouts), with a conservative generic fallback for anything else.

A completion only fires a notification after a short confirmation window, which filters out the brief idle flickers an agent shows between turns — so "task done" pings are trustworthy.

## Where things live

For the deeper conventions — the PTY output pipeline tuning, WebGL context management, the IPC plumbing pattern, theming, and persistence layout — see [`CLAUDE.md`](../CLAUDE.md) at the repo root, which documents the codebase in detail for contributors.

## Tech stack

- **Electron 42** — desktop shell
- **React 19 + TypeScript 5.8** — renderer UI
- **Vite 5 + Electron Forge 7** — bundling and packaging
- **xterm.js 6 + WebGL + node-pty** — terminals
- **Monaco editor** — default file editor, inline diff, and the conflict / 3-way merge view
- **CodeMirror 6** — alternative editor engine (with `@codemirror/merge` for its inline diff)
- **react-markdown + remark-gfm + Mermaid** — markdown rendering
- **GramJS (`telegram`)** — MTProto client for Telegram remote agents
- **electron-updater** — auto-updates from GitHub Releases

## Platform notes

- **macOS** — `.dmg` + `.zip`, signed and notarized with an Apple Developer ID, native `hiddenInset` title bar, Dock integration, auto-updates.
- **Windows** — Squirrel `.exe` installer with a custom title-bar overlay. Not yet EV-signed, so SmartScreen warns on first launch.
- **Linux** — `.deb` and `.rpm`, custom title-bar overlay.
