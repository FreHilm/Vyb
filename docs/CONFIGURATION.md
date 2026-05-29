# Configuration

Almost everything in Vyb is configured through the UI — this page is a reference for what those settings mean and where they're stored. You rarely need to edit anything by hand.

## Profiles

A profile is one agent session: a name, a working directory, and the command to run. Create and edit profiles in the in-app profile editor; they're persisted to `profiles.json` (see [Data locations](#data-locations)).

A profile looks like this on disk:

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
| `id` | Unique identifier (auto-generated). |
| `name` | Display name in the sidebar. |
| `icon` | Path to a custom image, or empty for a generated avatar. |
| `workingDirectory` | Where the terminal starts. `~` is expanded automatically. |
| `command` | The command to run (`claude`, `codex`, `bash`, anything). |
| `args` | Command-line arguments. |
| `statusPatterns.ready` | Regexes that mark the agent as idle/ready. |
| `statusPatterns.needsInput` | Regexes that mark the agent as waiting for you. |

Built-in agents (Claude, Codex, Gemini, OpenCode) ship with sensible status patterns, so for those you usually only set a name and a directory.

## Settings

Open settings with `Cmd+,` (macOS) or `Ctrl+,` (Windows/Linux). It's organized into tabs.

### Appearance

| Setting | Description | Default |
|---------|-------------|---------|
| Base Hue | UI color hue (0–359), or 360 for grayscale | 240 |
| Darkness | How dark the background is (0–80) | 0 |
| Text Lightness | Text brightness (0 = white, 100 = black) | 12 |
| Profile Font Size | Sidebar text size (10–20px) | 13 |
| Agent Font Size | Agent terminal text size (10–24px) | 14 |
| Shell Font Size | Shell terminal text size (10–24px) | 14 |
| Quick Nav Key | Modifier for keyboard shortcuts (Cmd or Alt) | Cmd |

### Flames

The animated status indicators along each profile.

| Setting | Description | Default |
|---------|-------------|---------|
| Intensity | Brightness / opacity | 50 |
| Spread | How wide the flame spikes extend | 50 |
| Length | Width of the flame zone | 50 |
| Speed | Animation pace | 50 |

### Icons

AI-generated profile icons.

| Setting | Description | Default |
|---------|-------------|---------|
| Provider | Image service (Gemini or OpenAI) | Gemini |
| Model | Specific model (Nano Banana, GPT Image, etc.) | Nano Banana 2 |
| Prompt | Style description | Flat icon style |
| Reference Image | Optional image for visual consistency | — |
| Batch Generate | Generate icons for all profiles lacking one | — |

### Apps

Custom external-app launcher buttons. Each has a name, an icon from the built-in set (VS Code, Terminal, Git Branch, Folder, Globe, Rocket…), and a shell command using a `{path}` placeholder that's replaced with the active profile's directory.

### Integrations

| Setting | Used for |
|---------|----------|
| OpenAI API Key | Icon generation (GPT Image) and dictation (Whisper) |
| Gemini API Key | Icon generation (Nano Banana) and dictation fallback |

### Backup

Export or import all configuration — profiles, settings, layout, and icons — as a single ZIP.

## Keyboard shortcuts

Hold the configured modifier (default Cmd) to reveal on-screen navigation hints.

| Shortcut | Action |
|----------|--------|
| Mod + 1–9, 0 | Activate command-bar buttons (README, Files, Terminal, Folder, apps…) |
| Mod + ↑ / ↓ | Move between profiles |
| Mod + ← / → | Cycle between the agent pane and shell terminals |
| Ctrl + Cmd + = | Add a shell terminal split |
| Ctrl + Cmd + - | Close the last shell terminal |
| Ctrl + Shift + D | Toggle dictation |
| Cmd + , | Open Settings |

## Data locations

Everything lives under your platform's app-data directory:

- **macOS** — `~/Library/Application Support/Vyb/`
- **Windows** — `%APPDATA%\Vyb\`
- **Linux** — `~/.config/Vyb/`

Inside you'll find:

- `profiles.json` — profile definitions
- `settings.json` — appearance, fonts, keys, workspaces, pane sizes, and more
- `layout.json` — sidebar folder structure and ordering
- `icons/` — generated profile icons

> Running a development build (`npm start`) uses a separate `Vyb (Dev)` directory, seeded once from your real data, so dev and the installed app never share — or corrupt — each other's state.
