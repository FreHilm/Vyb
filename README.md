<p align="center">
  <img src="logo.png" alt="Power Agent Command Center" width="200" />
</p>

<h1 align="center">Power Agent Command Center</h1>

<p align="center">
  A desktop app for running and monitoring multiple AI agent terminal sessions in one unified interface.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41-47848F?logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-4.5-3178C6?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-5-646CFF?logo=vite" alt="Vite" />
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platforms" />
</p>

---

## Overview

Power Agent Command Center lets you manage multiple AI coding agents (Claude Code, Aider, Copilot CLI, or any terminal-based tool) from a single window. Each agent runs in its own embedded terminal with live status detection, so you always know which agents are working, waiting for input, or ready for the next task.

### Key Features

- **Multi-agent terminals** — Run any number of AI agents or shell processes side by side, each in a full xterm.js terminal with WebGL-accelerated rendering.
- **Live status detection** — Configurable regex patterns watch terminal output and classify each agent as *ready*, *working*, *needs input*, or *offline*. Status badges update in real time.
- **OS notifications** — Get notified when an agent finishes a task or needs your input, even when the app is in the background.
- **Profile management** — Save named profiles with custom commands, working directories, arguments, and status patterns. Organize profiles into collapsible folders with drag-and-drop.
- **Integrated shell** — Toggle a split-pane shell terminal beneath any agent for quick commands in the same working directory.
- **README viewer** — View any project's README.md directly in the app with full GitHub Flavored Markdown support.
- **AI-generated icons** — Generate unique profile icons using Gemini or OpenAI image APIs, with optional style reference images.
- **Customizable theme** — Adjust hue, darkness, and text brightness to match your preference. Separate font size controls for sidebar, agent terminals, and shell terminals.
- **Quick launchers** — One-click buttons to open the working directory in Finder, VS Code, or Fork.

## Getting Started

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** 9+
- A terminal-based AI agent installed (e.g., `claude` CLI) — optional, the app works with any command

### Installation

```bash
git clone <repo-url>
cd PowerAgentTerminal
npm install
```

### Development

```bash
npm start
```

This launches the app in development mode with hot reload via Electron Forge + Vite. The native module `node-pty` is rebuilt automatically.

### Build & Package

```bash
npm run package    # Package for current platform
npm run make       # Build distributable (DMG/ZIP on macOS, installers on Windows/Linux)
npm run lint       # Run ESLint across all .ts/.tsx files
```

## Configuration

### Profiles

Profiles are stored in `{userData}/profiles.json`. On first launch, the app copies `profiles.example.json` as a starting point:

```json
{
  "id": "claude-default",
  "name": "Claude Code",
  "icon": "",
  "workingDirectory": "~/projects/my-app",
  "command": "claude",
  "args": [],
  "statusPatterns": {
    "ready": ["[>]\\s*$", "\\$\\s*$"],
    "needsInput": ["\\(y\\/n\\)", "Allow .+\\?", "Do you want", "\\? \\("]
  }
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (auto-generated slug) |
| `name` | Display name shown in the sidebar |
| `icon` | Path to a custom icon image (or empty for generated avatar) |
| `workingDirectory` | Starting directory for the terminal (`~` is expanded automatically) |
| `command` | The command to run (e.g., `claude`, `aider`, `bash`) |
| `args` | Array of command-line arguments |
| `statusPatterns.ready` | Regex patterns that indicate the agent is idle/ready |
| `statusPatterns.needsInput` | Regex patterns that indicate the agent is waiting for user input |

Profiles are fully editable through the in-app profile editor — no need to edit JSON by hand.

### Settings

All settings are accessible via the settings dialog (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux):

| Setting | Description | Default |
|---------|-------------|---------|
| Base Hue | UI color hue (0-359), or 360 for grayscale | — |
| Darkness | How dark the UI background is (0-100) | — |
| Text Lightness | UI text brightness (0-100) | — |
| Profile Font Size | Sidebar text size (10-20px) | — |
| Agent Font Size | Agent terminal text size (10-24px) | — |
| Shell Font Size | Shell terminal text size (10-24px) | — |
| Icon Provider | AI image generation service (`gemini` or `openai`) | `gemini` |
| Icon Prompt Prefix | Customizable prompt for icon generation | Flat icon style |

### Folder Organization

Profiles can be organized into collapsible folders via drag-and-drop in the sidebar. The layout is saved automatically to `{userData}/layout.json`.

## Architecture

The app follows Electron's recommended security model with strict context isolation across three process boundaries:

```
┌─────────────────────────────────────────────────────┐
│  Main Process (src/main.ts, src/main/)              │
│  ├── PtyManager      — spawns/manages PTY instances │
│  ├── StatusDetector   — regex-based output analysis  │
│  ├── ConfigLoader     — profile/settings persistence │
│  └── IPC Handlers     — bridges all renderer requests│
├─────────────────────────────────────────────────────┤
│  Preload (src/preload.ts)                           │
│  └── contextBridge → exposes window.api             │
├─────────────────────────────────────────────────────┤
│  Renderer (src/renderer/, React 19)                 │
│  ├── App.tsx          — root state & routing         │
│  ├── Sidebar          — profile list with folders    │
│  ├── TerminalPane     — xterm.js + WebGL             │
│  ├── CommandBar       — quick-action buttons         │
│  ├── ProfileEditor    — profile CRUD modal           │
│  ├── SettingsDialog   — theme & config modal         │
│  └── ReadmeViewer     — markdown display             │
└─────────────────────────────────────────────────────┘
```

### Adding a New IPC Method

Changes are required in three files:

1. **`src/shared/types.ts`** — define the channel constant
2. **`src/main/ipc-handlers.ts`** — implement the handler
3. **`src/preload.ts`** — expose it on `window.api`

### Terminal Lifecycle

PTY creation is lazy and order-sensitive to ensure correct terminal dimensions:

1. `createTerminalInstance()` — creates xterm.js Terminal + FitAddon (hidden, not yet opened)
2. `openTerminal()` — called on first show: opens terminal in DOM, loads WebGL addon
3. `requestAnimationFrame` -> `fitAddon.fit()` -> `createTerminal()` IPC -> `resizeTerminal()`

### Status Detection

The `StatusDetector` in the main process:

- Strips ANSI escape codes from PTY output
- Maintains a 1000-character rolling buffer per terminal
- Matches configurable regex patterns with 800ms debounce
- Fires OS notifications on transitions to `ready` or `needs-input`
- Suppresses notifications when the app window is focused on that profile

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 41 |
| UI | React 19, TypeScript 4.5 |
| Bundler | Vite 5 + Electron Forge 7 |
| Terminal | xterm.js 6 + WebGL addon + node-pty |
| Markdown | react-markdown + remark-gfm |
| Packaging | Squirrel (Windows), ZIP (macOS), DEB/RPM (Linux) |

## Platform Support

| Platform | Format | Notes |
|----------|--------|-------|
| macOS | `.zip` | Native title bar, Dock integration |
| Windows | Squirrel installer | Custom title bar overlay |
| Linux | `.deb`, `.rpm` | Custom title bar overlay |

## Project Structure

```
src/
├── main.ts                        # Electron main process entry
├── preload.ts                     # Context bridge (window.api)
├── renderer.tsx                   # React mount point
├── main/
│   ├── ipc-handlers.ts            # All IPC message handlers
│   ├── pty-manager.ts             # PTY spawn & lifecycle
│   ├── status-detector.ts         # Agent status pattern matching
│   └── config-loader.ts           # Profile/settings/layout persistence
├── renderer/
│   ├── App.tsx                    # Root component & state
│   ├── App.css                    # Application styles
│   ├── theme.ts                   # Dynamic color system
│   └── components/
│       ├── Sidebar.tsx            # Profile list, folders, drag-and-drop
│       ├── ProfileItem.tsx        # Profile entry with status badge
│       ├── CommandBar.tsx         # Action buttons (README, Terminal, etc.)
│       ├── TerminalPane.tsx       # xterm.js split view
│       ├── ProfileEditor.tsx      # Add/edit profile modal
│       ├── SettingsDialog.tsx     # Theme & settings modal
│       ├── ReadmeViewer.tsx       # Markdown viewer
│       └── ResizeHandle.tsx       # Draggable pane dividers
└── shared/
    └── types.ts                   # TypeScript interfaces & IPC channels
```

## License

All rights reserved.
