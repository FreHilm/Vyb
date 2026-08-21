# Editor development-hygiene ideas — VS Code-inspired backlog

Status: **ideas / not started.** Candidate features building on the ripgrep-backed
go-to-definition (`src/renderer/lib/monaco-definitions.ts`, shipped in 0.9.7+).
Grouped by effort; each entry notes the infrastructure it reuses.

## Nearly free (Monaco config flags) — DONE

Shipped: bracket-pair colorization, indent guides, and word-based
autocomplete enabled on all Monaco editors (plain / diff / merge); *Trim
trailing whitespace on save* and *Final newline on save* added as opt-in
toggles under Settings → Functions, applied in `handleSave` (Excalidraw
scenes excluded — they must round-trip byte-identically).

## Cheap — reuses the go-to-definition infrastructure — DONE

Shipped: **Find All References** (⇧F12 / editor context menu → Search panel
pre-filled whole-word); **Go to Symbol in file** (⌘⇧O via a line-scan
`DocumentSymbolProvider` in `monaco-definitions.ts` — also the prerequisite
for breadcrumbs later); **workspace symbol search** (⌘P then `#name`,
rg-backed via `workspaceSymbolPattern`, opens at the definition line);
**TODO/FIXME/HACK** — "TODOs" button in the Search panel header plus
in-editor highlight + overview-ruler ticks (MonacoFileEditor decoration).

## Medium — high value

- **Modified-line gutter markers in the plain editor** (VS Code's green/blue/red
  bars) — HEAD baselines are already cached per file for the diff view
  (`gitBaselinesRef`); diff against the buffer and paint `deltaDecorations`.
  Shows what changed without switching to change mode.
- **Text-based rename (F2)** — wire Monaco's rename action to the existing
  replace-in-files machinery (per-match precision replacement already
  implemented). Needs a confirmation step: it's textual, not semantic.
- **Hover shows the definition** — reuse the definition lookup to render the
  target line + its preceding comment block in a hover card. Poor man's docs,
  no LSP.

## The big one

- **Enable Monaco's real language workers for TS/JS (+ JSON/CSS/HTML)** —
  `monaco-setup.ts` deliberately points every worker request at the base
  editor worker to keep the bundle lean. Flipping this on gives genuine
  IntelliSense: semantic completions, signature help, error squiggles, and
  semantic go-to-definition for the web stack (rg provider stays as the
  fallback for other languages).
  - Cost: ~1–2 MB bundle, per-language worker wiring in the Vite build, and
    feeding imported files into the TS service (extra-lib management for
    cross-file resolution).
  - Worth doing eventually; deserves its own release.

## Suggested first round (~a day, all proven infrastructure)

1. Config flags (brackets, word suggestions, whitespace-on-save)
2. Find All References → Search panel
3. Go to Symbol in file (⌘⇧O)
4. Modified-line gutter markers

Together they cover the hygiene loop felt while editing: see what changed,
jump around symbols, chase usages.
