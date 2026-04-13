<p align="center">
  <img src="logo.png" alt="AgentDispatch" width="200" />
</p>

<h1 align="center">AgentDispatch</h1>

<p align="center">
  A desktop app for running and monitoring multiple AI agent terminal sessions in one unified interface.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41-47848F?logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node-24_LTS-339933?logo=nodedotjs" alt="Node" />
  <img src="https://img.shields.io/badge/Vite-5-646CFF?logo=vite" alt="Vite" />
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platforms" />
</p>

---

## Overview

AgentDispatch lets you manage multiple AI coding agents (Claude Code, Aider, Copilot CLI, or any terminal-based tool) from a single window. Each agent runs in its own embedded terminal with live status detection, so you always know which agents are working, waiting for input, or ready for the next task.

### Key Features

- **Multi-agent terminals** — Run any number of AI agents, each in a full xterm.js terminal with WebGL-accelerated rendering. WebGL contexts are managed automatically (only active on visible terminals) to avoid hitting browser limits.
- **Splittable shell terminals** — Toggle a split-pane shell area beneath any agent, split into multiple side-by-side terminals with resizable dividers. Add with `Ctrl+Cmd+=`, close with `Ctrl+Cmd+-`.
- **Live status detection** — Configurable regex patterns watch terminal output and classify each agent as *ready*, *working*, *needs input*, or *offline*. Animated flame indicators show status on the active profile.
- **Configurable flame effects** — Tune the sidebar flame indicators via Settings > Flames: intensity, spread, length, and speed. Live preview of all three animation states.
- **OS notifications** — Get notified when an agent finishes a task or needs your input. Notifications include the profile icon and are suppressed when you're focused on that profile.
- **Profile management** — Save named profiles with custom commands, working directories, and status patterns. Organize profiles into collapsible folders with drag-and-drop reordering.
- **Keyboard navigation** — Hold a modifier key (Cmd or Alt, configurable) to reveal numbered shortcuts over command bar buttons, arrow indicators for profile cycling (up/down) and pane cycling (left/right through agent and shell terminals).
- **README viewer** — View any project's README.md rendered with full GitHub Flavored Markdown. Auto-focuses for keyboard scrolling.
- **File explorer** — Built-in file browser with CodeMirror 6 editor (syntax highlighting for JS/TS/JSON/CSS/HTML/Python/Markdown), image preview, save support (Cmd+S), and unsaved changes dialog.
- **AI-generated icons** — Generate unique profile icons using Gemini (Nano Banana 2, Pro) or OpenAI (GPT Image 1, DALL-E 3) with optional style reference images for consistency. Batch generate for all profiles at once.
- **Customizable theme** — Adjust hue (full color wheel + grayscale), darkness, and text brightness. Separate font sizes for sidebar, agent terminals, and shell terminals.
- **Update indicators** — Profiles flash a colored highlight (green for ready, yellow for needs-input) when an inactive agent changes status.
- **Configurable quick launchers** — Add custom external app buttons (VS Code, Fork, iTerm, etc.) with selectable icons and shell commands using `{path}` placeholder.
- **Git status bar** — Shows branch, staged/modified/untracked counts, ahead/behind, stash count, last commit message, clickable link to open the repo on GitHub/GitLab/Bitbucket, and a fetch button to sync with origin.
- **Dictation** — Voice input via Ctrl+Shift+D using OpenAI Whisper or Gemini for transcription. Toggle or hold-to-record modes with configurable language.
- **Backup & restore** — Export/import all settings, profiles, layout, and icons as a ZIP file.
- **Resizable panes** — Drag handles between sidebar/main area and agent/shell terminals. Sizes persist across sessions.

## Getting Started

### Prerequisites

- **Node.js** 24+ LTS (recommended, uses nvm)
- **npm** 11+
- A terminal-based AI agent installed (e.g., `claude` CLI) — optional, the app works with any command

### Installation

```bash
git clone <repo-url>
cd AgentDispatch
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

Profiles are stored in `{userData}/profiles.json`. Each profile defines an agent session:

```json
{
  "id": "claude-default",
  "name": "Claude Code",
  "icon": "",
  "workingDirectory": "~/projects/my-app",
  "command": "claude",
  "args": ["--continue"],
  "statusPatterns": {
    "ready": ["for\\s*shortcuts", "\\$\\s*$"],
    "needsInput": ["\\(y\\/n\\)", "Allow\\s*once", "Yes.*No.*Always"]
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
| `args` | Array of command-line arguments (default: `["--continue"]`) |
| `statusPatterns.ready` | Regex patterns that indicate the agent is idle/ready |
| `statusPatterns.needsInput` | Regex patterns that indicate the agent is waiting for user input |

Profiles are fully editable through the in-app profile editor — no need to edit JSON by hand.

### Settings

All settings are accessible via the settings dialog (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux), organized into tabs:

#### Appearance

| Setting | Description | Default |
|---------|-------------|---------|
| Base Hue | UI color hue (0-359), or 360 for grayscale | 240 |
| Darkness | How dark the UI background is (0-80) | 0 |
| Text Lightness | UI text brightness (0=white, 100=black) | 12 |
| Profile Font Size | Sidebar text size (10-20px) | 13 |
| Agent Font Size | Agent terminal text size (10-24px) | 14 |
| Shell Font Size | Shell terminal text size (10-24px) | 14 |
| Quick Nav Key | Modifier for keyboard shortcuts (Cmd or Alt) | Cmd |

#### Flames

| Setting | Description | Default |
|---------|-------------|---------|
| Intensity | Brightness/opacity of the flame indicators | 50 |
| Spread | How wide the flame spikes extend horizontally | 50 |
| Length | Width of the flame zone along the profile edge | 50 |
| Speed | Animation pace (slow breathing to rapid flicker) | 50 |

#### Icons

| Setting | Description | Default |
|---------|-------------|---------|
| Provider | AI image generation service (Gemini or ChatGPT) | Gemini |
| Model | Specific model (Nano Banana 2/Pro, GPT Image 1, DALL-E 3, etc.) | Nano Banana 2 |
| Prompt | Style description for generated icons | Flat icon style |
| Reference Image | Optional image for visual style consistency | — |
| Batch Generate | Generate icons for all profiles without one | — |

#### Apps

Configure external app launchers. Each app has a name, icon (from built-in set: VS Code, Code, Terminal, Git Branch, Folder, Globe, Rocket, etc.), and a shell command with `{path}` placeholder.

#### Integrations

| Setting | Description |
|---------|-------------|
| OpenAI API Key | For icon generation (GPT Image) and dictation (Whisper) |
| Gemini API Key | For icon generation (Nano Banana) and dictation fallback |

#### Backup

Export/import all configuration (profiles, settings, layout, icons) as a ZIP file.

### Keyboard Shortcuts

Hold the configured modifier key (default: Cmd) to reveal navigation hints:

| Shortcut | Action |
|----------|--------|
| Mod + 1-9, 0 | Activate command bar buttons (README, Files, Terminal, Folder, apps...) |
| Mod + ↑ / ↓ | Navigate between profiles |
| Mod + ← / → | Cycle between agent pane and shell terminals |
| Ctrl + Cmd + = | Add a new shell terminal split |
| Ctrl + Cmd + - | Close the last shell terminal |
| Ctrl + Shift + D | Toggle dictation |
| Cmd + , | Open Settings |

## Architecture

The app follows Electron's recommended security model with strict context isolation:

```
┌──────────────────────────────────────────────────────┐
│  Main Process (src/main.ts, src/main/)               │
│  ├── PtyManager       — spawns/manages PTY instances │
│  ├── StatusDetector    — regex-based output analysis  │
│  ├── ConfigLoader      — profile/settings persistence │
│  └── IPC Handlers      — bridges all renderer requests│
├──────────────────────────────────────────────────────┤
│  Preload (src/preload.ts)                            │
│  └── contextBridge → exposes window.api              │
├──────────────────────────────────────────────────────┤
│  Renderer (src/renderer/, React 19)                  │
│  ├── App.tsx           — root state & routing         │
│  ├── Sidebar           — profiles, folders, drag-drop │
│  ├── TerminalPane      — agent terminals (xterm.js)   │
│  ├── ShellPane         — splittable shell terminals   │
│  ├── CommandBar        — quick-action buttons + nav   │
│  ├── FileExplorer      — file tree + CodeMirror editor│
│  ├── ReadmeViewer      — markdown display             │
│  ├── StatusBar         — git status & remote link     │
│  ├── SettingsDialog    — tabbed settings              │
│  ├── ProfileEditor     — profile CRUD + icon gen      │
│  └── KeyNav            — keyboard navigation system   │
└──────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 41 |
| UI | React 19, TypeScript 5.8 |
| Bundler | Vite 5 + Electron Forge 7 |
| Terminal | xterm.js 6 + WebGL + node-pty |
| Editor | CodeMirror 6 (one-dark theme) |
| Markdown | react-markdown + remark-gfm |
| Packaging | Squirrel (Windows), ZIP (macOS), DEB/RPM (Linux) |

## Platform Support

| Platform | Format | Notes |
|----------|--------|-------|
| macOS | `.zip` | Native title bar (`hiddenInset`), Dock integration |
| Windows | Squirrel installer | Custom title bar overlay |
| Linux | `.deb`, `.rpm` | Custom title bar overlay |

## License

MIT -- see [LICENSE](LICENSE).

Third-party dependency licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
