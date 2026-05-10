# remove.md

Features to consider deleting from the codebase. Rationale + scope per
item, ordered roughly by "biggest cleanup, least missed". Not a hard
recommendation — read each one and pick the ones you agree with.

## Strong drop candidates

### 1. AI-generated profile icons (Gemini + OpenAI)

**What it does.** Settings → Appearance has a Gemini / OpenAI picker,
prompt prefix, optional reference image, and an "AI Generate" button
in the profile editor that creates a square PNG via the chosen
provider and saves it to `{userData}/icons/{profileId}.png`. There's
also a batch-generation flow.

**Why drop.**
- Adds an API-key requirement (Gemini or OpenAI) just to get an icon.
  That's setup friction for a cosmetic feature.
- Significant main-process surface: image-generation IPC, two provider
  HTTP integrations, image-storage/cache-bust logic, the `iconRevision`
  counter, the batch-generation orchestration.
- Settings UI: provider toggle, model picker, API-key fields, prompt
  prefix, reference-image picker. Easy to delete a whole tab.
- Users can drop in any image. They probably already have a project
  logo or want to use an emoji.

**What stays.** The profile-icon UI itself (the round image badge in
the sidebar) — only the *generation* path goes. `profile.icon` is
still a path; users pick one with the existing "Browse" button.

**Files to clean up (rough).** `src/main/ipc-handlers.ts` (icon-gen
handler + helpers), `src/renderer/components/ProfileEditor.tsx`
(remove the AI Generate button and `handleGenerateIcon`), Settings →
Appearance icon-provider section, related fields in `AppSettings`,
the `icons/` directory (kept for user-supplied icons), and the icon
cache-bust counter wiring.

---

### 2. Backup / restore (ZIP)

**What it does.** Settings → Backup has Export and Import buttons that
zip / unzip `profiles.json`, `settings.json`, `layout.json`, and the
`icons/` directory.

**Why drop.**
- Nobody picks a tool because of its export feature.
- The whole config lives in `~/Library/Application Support/Vyb/`.
  `cp -R` and `rsync` already work; users who care about backup are
  already running Time Machine or similar.
- Pulls in `archiver` and `adm-zip` as runtime deps (both externalised
  in `vite.main.config.ts`), one of which we'd otherwise not need.
- Two more IPC channels (`BACKUP_EXPORT` / `BACKUP_IMPORT`) and Settings
  UI to maintain.

**What to do instead.** A one-paragraph note in the README pointing at
the userData path. That's the export instructions. If someone asks for
a real export feature later, you can rebuild it in a day.

---

### 3. Voice dictation (audio transcription IPC)

**Caveat:** the pitch keeps "talk to your agent" as a feature, so
think before dropping. **If you're going to drop it from the app,
also drop it from the pitch.** It's the smallest of the three "drop
candidates" in code surface but the most talked-about.

**What it does.** Renderer records audio via the Web Audio API,
encodes it, sends to main, main forwards to Gemini for transcription,
text returns and is dropped at the cursor.

**Why consider dropping.**
- Network round-trip to a third-party API for every dictation. Not
  local-first.
- Requires a Gemini API key — same setup-friction problem as the icon
  generator.
- Niche. Most developers prefer typing; the people who use voice tend
  to use macOS dictation already.
- Audio-recording code in the renderer + base64 encoding + a
  `TRANSCRIBE_AUDIO` IPC + the dictation-mode and dictation-lang
  settings to maintain.

**Why keep.**
- It is a memorable demo. "I dictated the whole spec into the agent"
  is a clip worth showing.
- The pitch leans on it as a small differentiator.

**Suggested middle path.** Keep dictation, but switch the back-end to
Web Speech API (browser-native, no network, no API key) if cross-
platform support is acceptable. Removes the Gemini coupling without
losing the feature.

---

## Lighter trim candidates

### 4. GPU-acceleration setting

Settings → Appearance has a `auto / canvas / off` picker for the xterm
renderer. xterm-webgl auto-falls-back when context creation fails.
You don't need a user-facing knob. Drop the setting; just always try
WebGL first.

### 5. Flame intensity / spread / length / speed sliders

The flame indicator is one of Vyb's signature visual touches. The
*four* sliders to tune it (intensity, spread, length, speed) is
overkill. Pick good defaults, drop the sliders, keep the flame.

### 6. The two flow-control / coalesce constants

Don't *delete* them, but stop calling them out as configurable. The
pitch sells the values as VS-Code-equivalent — they should be hard
constants, not settings.

### 7. `permissionModeArgs` for non-parallel agent spawns

The setting only kicks in for Kanban-dispatched parallel-agent
worktrees. The plain `args` field is what users actually edit. Hide
`permissionModeArgs` from the Settings → Agents UI; keep it in the
JSON for the parallel path. (Or drop the parallel-mode permission
distinction entirely if you find users don't care.)

### 8. Profile-rename via the editor's Name field

This already works — but the new branch-rename flow we just shipped
suggests inline-rename on the sidebar profile row. Cheap UX win,
probably worth *adding* not removing — flagging it here as a
follow-up.

---

## Hold the line on these (don't remove)

A short list of things that might *look* removable but earn their
keep:

- **Hotkey nav** (⌘+number overlay) — productivity feature, real
  daily-driver value.
- **Drag-and-drop file moves** in both trees — small implementation,
  high "this is a real product" signal.
- **Right-click context menus everywhere** — expected UX; removing
  any of them downgrades polish noticeably.
- **Cherry-pick / revert / reset / worktree / rebase** — these are
  what differentiate Vyb's git tooling from the "show diff" tier.
- **Conflict-state banners** — distinctive UX detail; keeps users out
  of the terminal for the easy 80% of conflicts.
- **The Catppuccin hue dial** — single most "indie product" signal in
  the whole app. Keep.
- **Markdown nav tree + edit mode** — concrete differentiator vs the
  competitors that only show a single README.

---

## Summary

| Priority | Feature | Why |
|---|---|---|
| 🔴 Drop | AI-generated profile icons | API-key friction, cosmetic, big code surface |
| 🔴 Drop | Backup / restore (ZIP) | Filesystem copy already works, two deps |
| 🟡 Maybe | Voice dictation (Gemini) | Or switch to Web Speech API to keep without API key |
| 🟡 Trim | GPU acceleration setting | Auto-detect; hide the knob |
| 🟡 Trim | Flame slider quartet | One slider or none; keep the flame |
| 🟡 Trim | Pipeline tuning constants | Not user-facing; hard-code |
| 🟢 Keep | Everything else | See "Hold the line" above |

Estimated lines of code removed if you do the three 🔴 items: somewhere
around 600–900 (icon-gen + ZIP + audio-transcription IPC + their UI).
