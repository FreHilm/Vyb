# Building from source

Most people should just grab a [pre-built release](https://github.com/FreHilm/vyb/releases). Build from source if you want to develop Vyb or produce a build for a platform/configuration the releases don't cover.

## Prerequisites

- **Node.js 24+ LTS** (e.g. `nvm use 24`)
- **npm 11+**
- Optionally, a terminal AI agent on your `PATH` (`claude`, `codex`, `gemini`, `opencode`) to actually drive — Vyb runs whatever command a profile points at.

## Setup

```bash
git clone https://github.com/FreHilm/vyb.git
cd vyb
npm install
```

The native `node-pty` module is rebuilt against Electron's headers automatically, and a `postinstall` step prepares the macOS dev shell.

## Development

```bash
npm start
```

Launches the app with hot reload via Electron Forge + Vite. A dev build stores its data in a separate `Vyb (Dev)` directory (seeded once from the installed app's data), so running it alongside an installed Vyb won't touch your real profiles or settings.

## Building distributables

```bash
npm run package   # package for the current platform (no installer)
npm run make      # build installers: .dmg + .zip (macOS), .exe (Windows), .deb + .rpm (Linux)
npm run lint      # ESLint across all .ts/.tsx files
```

## Releasing

Releases are automated. Pushing a `v*.*.*` tag triggers `.github/workflows/release.yml`, which builds on macOS, Windows, and Linux runners in parallel and uploads the artifacts to a draft GitHub Release.

```bash
npm run publish   # build + upload to a GitHub Release (used by CI)
```

The macOS job signs and notarizes the build, so the published `.dmg` opens without a Gatekeeper warning. That requires the signing secrets to be configured in the repository (an Apple Developer ID certificate, an app-specific password for notarization, and the team ID). Local `npm run make` builds are unsigned and skip notarization unless those values are present in the environment.

## Dependencies & licensing

Vyb is MIT-licensed, so runtime dependencies must use compatible permissive licenses (MIT, ISC, Apache-2.0, BSD, 0BSD). Copyleft licenses (GPL/LGPL/AGPL/MPL) are not allowed for runtime deps. When you add a runtime dependency, record it in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Contributor notes

The repo root [`CLAUDE.md`](../CLAUDE.md) documents the codebase conventions in depth — the PTY output pipeline, terminal lifecycle, status-detection adapters, IPC plumbing pattern, theming, and persistence. It's the best starting point before making changes.
