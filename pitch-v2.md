# Vyb

**A desktop home for your AI coding agents.**

Many projects, one window. Many agents, one home.

[screenshot: sidebar with four profiles in different statuses — Claude
working, Codex ready, Gemini needs-input, OpenCode offline]

Run Claude on one project, Codex on another, Gemini on a third — each
with its own folder, terminal, and identity. Edit files, stage
changes, push, open a PR — without leaving the window.

Vyb is the missing front-end for the agent CLIs you already use.

> Terminal pipeline tuned to match VS Code's. Status detection on a
> worker thread. MIT all the way down. No copyleft. No telemetry.

---

## In the sidebar

Profiles are *agent + folder + identity*. Click to switch; the agent's
terminal is right there.

A live status badge per profile (🟢 ready · 🔵 working · 🟡 needs
input · ⚫ offline). A flame on the active profile that breathes when
idle and dances when working. Notifications fire when an agent really
needs you — Vyb waits 5 seconds before any "task done" bell so
transient idle blips don't false-positive.

Status detection runs on a Node worker thread. Adapters for Claude,
Codex, Gemini, OpenCode out of the box; adding another is a few
lines.

---

## Terminals, files, markdown

`node-pty` PTYs through `xterm.js` with WebGL when your GPU allows.
Drag a file from anywhere to drop its path at the cursor. The PTY
→ renderer pipeline runs at 5 ms coalesce + byte-accurate flow
control, so `cat large.log` doesn't choke the UI.

A CodeMirror 6 editor in tabs for quick file edits. A markdown viewer
with its own folder tree, filtered to `.md`. Click a file path in the
agent's output and it opens, with the matching tree node expanded.

Plus the kind of touches you notice once: **⌘+number hotkey nav**
to jump anywhere without the mouse, **hold-to-talk dictation** for
when you've got the idea but not the patience to type, a **single
hue dial** that goes from Catppuccin to greyscale, and **toolbar
buttons** that open the active profile in VS Code, Fork, or anything
else you wire up — Vyb lives *next* to your tools, not on top of
them.

---

## How parallel agents work

01. **Drop a task** onto a parallel-enabled profile.
02. **Vyb spawns a worktree** — isolated git checkout on a fresh
    feature branch.
03. **A new agent boots in it** with the task pre-loaded.
04. **Your main agent keeps working** on whatever it was already
    doing.
05. **The agent finishes** → optional `gh pr create --fill` opens the
    PR for you.

[loop or annotated screenshot: drag a task → agent works → PR appears]

The Kanban lives inside the repo, scoped to the active profile. Tasks
arrive in the agent prefixed with a small context block ("This is a
task from the board, ask clarifying questions if needed…"). The whole
loop — questions, edits, commit, push — happens in one window.

---

## Git

The biggest piece. Most agent GUIs stop at "show diff" — Vyb ships
the whole tool, so you don't context-switch to Fork or Tower for
routine work. Three tabs side-by-side with the agent terminal:

- **Changes** — staged + unstaged with one-click stage / unstage.
  Subject + body. Commit. ⌘↵ to ship.
- **Tree** — Fork-style commit graph rendered client-side
  (MIT-clean, no GPL deps). Lane-coloured ref pills. Right-click any
  commit for **Checkout / Merge / Cherry-pick / Revert / Reset /
  New branch / New tag / Copy SHA**.
- **Branches** — folder-grouped local / remote / tags / stashes, with
  the same toolkit plus **Rebase / Tracking / Rename / Worktree** and
  **Create PR** via `gh`.

When a merge, rebase, cherry-pick, or revert hits a conflict, Vyb
leaves it in-progress, lists the conflicted files, and gives you
**Abort** + **Continue** buttons in a banner above the panel. Resolve
in the shell pane, click Continue, done. Vyb reads the same
`.git/MERGE_HEAD`, `.git/rebase-apply/`, `.git/CHERRY_PICK_HEAD`,
`.git/REVERT_HEAD` markers git itself uses — no detection guesswork.

[screenshot: conflict-state banner — rebase in progress, conflicted
files listed, Abort + Continue buttons]

---

## What it isn't

Not a hosted service — Vyb runs locally and talks only to the agents
you have installed. Not an agent itself — bring your own. Not a full
IDE; the built-in editor is for quick edits, VS Code is a button
away. Not yet a power-user git GUI — interactive rebase, multi-
branch selection, and submodules are deliberately out for now.

---

## Why not X?

- **Anthropic's official Claude Code Desktop** runs Claude
  beautifully. Vyb runs Claude *and* Codex *and* Gemini *and*
  OpenCode, and replaces the diff viewer with a full Fork-style git
  UI.
- **claude-squad** is the right answer if you live in tmux. Vyb is
  what claude-squad would look like as a desktop app — sidebar, file
  editor, git GUI, markdown viewer, keyboard nav.
- **Blackcrab / opcode / Claudia / Code-Bar** are polished
  single-vendor wrappers. Vyb's bet is that you'll use more than one
  agent over the next year, and that "many projects, one window"
  beats "many windows, one project".
- **VS Code's agent panel / JetBrains Air** are great if your home is
  the IDE. Vyb is for people whose home is the terminal — the agent
  comes first, the editor is a side trip.

---

## Built on

Electron 41 · React 19 · TypeScript 5.8 · xterm.js v6 (WebGL) ·
node-pty · `worker_threads` for status detection · electron-forge +
Vite · Catppuccin-derived theming.

Three process boundaries with strict context isolation. No telemetry,
no accounts, no cloud.

---

## Open source

MIT. Every runtime dependency is permissive (MIT / ISC / Apache-2.0 /
BSD). No copyleft anywhere in the tree.

Source · Releases · License: MIT

---

## Get it

```
nvm use 24
npm install
npm start          # dev mode with HMR
npm run make       # build a distributable
```

macOS first-class. Windows + Linux ~90% supported.
