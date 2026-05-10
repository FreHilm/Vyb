# Vyb

**A desktop home for your AI coding agents.**

Many projects, one window. Many agents, one home.

Pop open Claude on one project, Codex on another, Gemini on a third —
each with its own folder, terminal, status badge, and chosen CLI. Drop
into a shell beside the agent. Browse the repo. Read or edit a markdown
file. Stage your changes, commit, push, open a PR — without leaving the
window.

Vyb is the missing front-end for the agent CLIs you already use.

> **Under the hood:** terminal pipeline tuned to match VS Code's (5 ms
> coalescing, byte-accurate flow control), status detection on a worker
> thread so it never blocks paint, MIT all the way down, no copyleft
> anywhere in the dependency tree, and zero telemetry.

---

## Why I built it

I run several AI coding agents across different projects and got tired
of:

- juggling terminal tabs (which Claude session is in which folder?)
- copy-pasting paths between the agent CLI and my editor
- losing context when an agent finishes a task while I'm in another
  window
- reaching for a separate git GUI when I just wanted to commit and push

Vyb is one window where every agent has a home.

---

## In the sidebar

A vertical list of **profiles** — each is an agent + a working
directory + an icon. Click to switch. The agent's terminal is right
there, ready to type into.

Every profile carries a live **status badge**:

- 🟢 ready · 🔵 working · 🟡 needs input · ⚫ offline

A flame on the active profile breathes when it's idle and dances when
it's working. The system notifies you when an agent needs attention,
not when it briefly idles between turns — Vyb waits five seconds
before firing the bell so you don't get false-positive "task done"
pings.

Per-agent status detection runs on a Node `worker_threads` worker, so
all the regex / ANSI-stripping work happens off the main event loop.
Built-in adapters cover Claude, Codex, Gemini, and OpenCode out of the
box. Adding another agent is a few lines.

---

## In the main pane

### Git, in three tabs

The biggest single piece — most agent GUIs stop at "show diff", Vyb
ships a full client-side git tool so you don't context-switch to
Fork or Tower for routine work.

- **Changes** — staged + unstaged sections with one-click stage /
  unstage arrows. Subject + body inputs. A Commit button. ⌘↵ to commit.
  Push and Pull buttons in the status bar that light up when there's
  something to do.

- **Tree** — a Fork-style commit graph rendered client-side (MIT-clean,
  no GPL deps). Lane allocation, branch / tag / remote chips coloured to
  match the lane they sit on. A green stripe marks the row where your
  working copy is. Right-click any commit for **Checkout**, **Merge**,
  **Cherry-pick**, **Revert**, **Reset (soft / mixed / hard)**,
  **New branch**, **New tag**, **Copy SHA**.

- **Branches** — folder-grouped local / remote-tracking / tags /
  stashes, with the same right-click toolkit plus **Rebase**,
  **Tracking** (set/unset upstream), **Rename**, **Worktree**, and
  **Create Pull Request** via the `gh` CLI.

#### Conflict-state banners

If a merge / rebase / cherry-pick / revert hits a conflict, Vyb leaves
it in-progress, lists the conflicted files at the top of the panel,
and gives you **Abort** + **Continue** buttons. Resolve in the shell
pane below. Click Continue. No guesswork — Vyb reads the same
`.git/MERGE_HEAD`, `.git/rebase-apply/`, `.git/CHERRY_PICK_HEAD`,
`.git/REVERT_HEAD` markers git itself uses.

### Native terminals

`node-pty` PTYs piped through `xterm.js` with the WebGL renderer when
your GPU allows. Drag a file in from anywhere — the path gets
shell-escaped and dropped at the cursor. Cmd+C / Cmd+V / Cmd+F all
behave like a real terminal. Per-profile shell terminals live in a
splittable pane below the agent.

The PTY → renderer pipeline is tuned to match what VS Code does: 5 ms
coalesce window, 5 KB byte budget, `Uint8Array` wire format, parser-ack
flow control. Even a `cat large.log` doesn't choke the UI.

### File explorer

CodeMirror 6 in a tabbed editor on the left, a lazy-loading tree on the
right. Drag-and-drop files between folders. Right-click for delete /
rename / new file / new folder. Click a file path in the agent's
output and it opens in a tab, with the matching tree node expanded.

### README viewer

A second tree, this one filtered to folders + `.md` files. Markdown
renders inline; flip a toggle to edit, type, ⌘S to save. Inline
relative `.md` links navigate within the viewer.

---

## Kanban + parallel agents

Each profile gets a built-in Kanban board scoped to its working
directory. Drag a card onto the agent and the task lands in stdin,
prefixed with a small context block ("This is a task from the board,
ask clarifying questions if needed…"). Clarifying questions, code
edits, the whole loop — all in one window.

Mark a profile **parallel-enabled** and dispatched cards no longer
interrupt the running agent. Each task gets its own isolated git
worktree, a feature branch, and a fresh agent spawned just for it.
Your main agent keeps working on whatever it was doing. When the
parallel agent reports `status: done`, optional auto-push +
`gh pr create --fill` opens the PR for you.

---

## Useful little things

- **Hotkey nav** — hold ⌘ to overlay numbers on every button + pane.
  Tap a number to jump. No mouse, no menu.
- **Talk to your agent** — hold to dictate (or toggle), let go, and a
  full paragraph of spec lands at the agent's cursor. Skip the typing
  when you've got the idea but not the patience.
- **Themes** — Catppuccin-derived palette with a single hue dial. Spin
  it to 360° for greyscale.
- **External app shortcuts** — open the active profile in VS Code,
  Fork, or anything you wire up via `{path}` substitution. Vyb lives
  *next* to your other tools, not on top of them.

---

## What it isn't

- Not a hosted service. Vyb runs locally and talks only to the agents
  you have installed.
- Not an agent itself. Bring your own — Claude, Codex, Gemini,
  OpenCode, or anything you can launch from a shell.
- Not a full IDE. The built-in editor is for quick edits; VS Code is a
  toolbar button away.
- Not a power-user git GUI (yet). Interactive rebase, multi-branch
  selection, and submodules are deliberately out for now.

---

## Why not X?

The space has gotten crowded — here's how Vyb sits next to the
neighbours.

- **Anthropic's official Claude Code Desktop** ships with parallel
  agents in worktrees, an integrated terminal, and a great diff
  viewer. It's free, fast, and well-tuned. Its limit is the name on
  the door — it runs Claude. Vyb runs Claude *and* Codex *and* Gemini
  *and* OpenCode in one window, and replaces the diff viewer with a
  full Fork-style git UI: branches, remotes, tags, stashes, the commit
  graph, conflict-state banners, PR creation.

- **claude-squad** is the right answer if you live in tmux. It nails
  the multi-agent + worktree-isolation story in the terminal. Vyb is
  what claude-squad would look like if it were a desktop app instead
  — you get the profile sidebar, the file editor, the git GUI, the
  markdown viewer, and the keyboard nav for free.

- **Blackcrab / opcode / Claudia / Code-Bar** are polished
  single-vendor wrappers. They make Claude Code (or Claude+Codex)
  beautiful. Vyb's bet is that you'll use more than two agents over
  the next year, and that "many projects, one window" beats "many
  windows, one project".

- **VS Code's agent panel** and **JetBrains Air** are great if your
  mental home is the IDE. Vyb is for people whose mental home is the
  terminal — the agent comes first, the editor is a side trip.

---

## Built on

- Electron 41 · Chromium 134 · Node 24
- React 19 · TypeScript 5.8
- xterm.js v6 (WebGL) · node-pty
- A `worker_threads` worker for status detection
- electron-forge with Vite for build
- Catppuccin-derived theming

Three process boundaries with strict context isolation. No telemetry.
No accounts. No cloud.

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

macOS first-class. Windows + Linux ~90% supported (the title bar,
external-app commands, and a couple of platform-specific tweaks
diverge — see `CLAUDE.md` for the details).

---

## A note on the name

Vyb is short for "vibe." That's the energy I wanted: agents and tools
arranged so working with them feels less like ops and more like
flow. If it doesn't feel right, file a bug.
