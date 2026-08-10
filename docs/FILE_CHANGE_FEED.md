# File Change Feed — feasibility + design notes

Status: **idea / not started.** Captures the feasibility read so we can pick it up later.

## The idea

A new view (sibling of the README / Files / Kanban overlays) that acts as a **live feed of file changes** in the active profile's working directory. A filesystem observer listens for changes and renders each one as a card in a reverse-chronological flow: the file, then the change (a compact diff). More interactive than the current per-file "show changed files" view — think a live activity log of what the agent is doing to the codebase.

## Feasibility: yes

Most building blocks already exist in Vyb:

- **The watcher** — `ipc-handlers.ts` already runs recursive `fs.watch` on macOS/Windows (FSEvents / ReadDirectoryChangesW) with noise filters (`WATCH_IGNORE_SEGMENTS`: `.git`, `node_modules`, `dist`, `.next`, …) and guards against cloud-sync dirs that blow up memory (`CLOUD_SYNC_DIRS`). This is the hard, gotcha-prone part and it's done. Today it just triggers a tree refresh; we'd extend it to emit per-file change events.
- **`getGitFileAtHead`** IPC — for baselines / cumulative diffs.
- **Monaco / CodeMirror diff rendering** — reuse for the inline diff inside each card.
- **The overlay/tab pattern** (README/Files/Kanban) — drop in a new "Changes" tab scoped to the active profile's cwd.
- **`gitDecorations`** — git context (tracked? staged?).

The one genuinely new piece: turning "file X changed" into "here's *the diff* for that change," then streaming those as cards.

## Key design decision: diff against *what*?

Defines the whole feel.

1. **vs last-seen snapshot** → true per-save delta ("added these 3 lines, just now"). Most "flow"-like. Needs an in-memory content cache per file. **Recommended for the live-feed feel.**
2. **vs git HEAD** → cumulative diff (what the current change view shows). Reuses `getGitFileAtHead`, but each event re-renders the whole accumulated diff — less "each change as it appears."
3. **vs git index** → "what's unstaged" variant.

Suggested: **#1 (snapshot delta)** for the feed, with a per-card option to "anchor to HEAD" for cumulative context on click.

## Challenges to plan for

- **Volume / debounce.** Agents + build tools write in bursts. Per-file coalescing (same idea as the existing PTY output coalesce) and gitignore-awareness beyond the current segment list.
- **Atomic saves.** Many tools write temp + rename, so a save appears as rename/create, not modify. Must handle or diffs look wrong.
- **Linux gap.** Current recursive `fs.watch` only reliably gives *top-level* events on Linux (code notes this and just re-lists the tree). A feed needs the *exact nested file*, so Linux would likely need `chokidar` (MIT) or a manual recursive watch. macOS/Windows already give exact paths.
- **Binary / large files** → show "binary changed" / size delta; don't diff.
- **Deletes & renames** as first-class feed entries, not just content diffs.
- **Memory** — snapshot cache needs a cap/eviction; feed itself capped (like scrollback).

## Compelling angle: agent attribution

The view is scoped to the active profile's dir, so every change is implicitly "**this agent's edits**." Group cards by the agent's working→ready turns (already tracked) so the feed reads as "Turn 3: edited 4 files" — a live activity log of the agent. Differentiator vs a plain git diff.

## Rough shape & effort

- **Main:** a `FileChangeWatcher` per active profile → emits coalesced `ChangeEvent { path, type, hunks, ts }` over a new IPC channel.
- **Renderer:** reverse-chronological feed of `ChangeCard`s (path header + compact diff), with filters (by file / type), pause/clear, click-to-open-at-change.
- **Effort:** moderate. Watcher + diff plumbing is the bulk; UI is straightforward given the existing diff editors. Main risks: noise/perf on busy repos, and snapshot-baseline memory.

## Open decisions before building

1. **Baseline model** — snapshot delta (#1) vs HEAD (#2).
2. **Platform scope** — macOS/Windows-first, or add `chokidar` for Linux day one.

These two size the whole feature. Decide them, then write a concrete implementation plan.

## Interactivity wishlist (later)

- Click a card → open the file at that change in the editor.
- Expand/collapse the inline diff per card.
- Filter by file, by change type (add/modify/delete/rename).
- Pause / resume / clear the feed.
- Possibly: stage / revert a change straight from a card.
