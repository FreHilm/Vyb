# Monaco editor: migration plan + spike

Status: **spike** behind a setting. With the Monaco engine on, the plain editor *and* the "show changed files" inline diff use Monaco; blame and markdown editing stay on CodeMirror. CodeMirror remains the default engine. This note records the plan so the decision is informed.

## Why consider it

Monaco (the editor that powers VS Code) would give the file view VS-Code-grade editing: IntelliSense-capable language services, a polished find/replace, multi-cursor, a minimap, and built-in sticky scroll. Several things Vyb hand-built on CodeMirror are native in Monaco, so adopting it deletes code rather than adding it.

## Why not (the cost)

- **Bundle weight.** Monaco is ~5 MB and relies on web workers; CodeMirror tree-shakes to ~200 KB. For a desktop app aiming to stay lean this is the main trade-off.
- **Inline diff is a different shape.** Vyb's "show changed files" view uses CodeMirror's `unifiedMergeView` as a *toggleable extension on the same editor*. Monaco's diff is a *separate component* (`DiffEditor`), so it can't be a toggle; it has to mount/unmount a different editor.
- **Blame gutter** has no Monaco built-in; it would be rebuilt on glyph-margin decorations.

## What maps how

| Area | CodeMirror today | Monaco | Effort |
|---|---|---|---|
| Syntax highlighting | `lang-*` packages | built-in | drop-in |
| Find / replace | custom panel wiring + theme | built-in | delete code |
| Sticky scroll | custom `lib/sticky-scroll.ts` (Lezer) | built-in option | **delete the plugin** |
| Minimap / multi-cursor | n/a | built-in | free |
| Undo / redo, dirty tracking, clipboard, font-size keys | hand-wired | adapts to Monaco events | easy |
| Theme | `EditorView.theme()` + `.cm-*` CSS | `defineTheme` + `.monaco-editor` CSS | mechanical |
| Inline diff | `unifiedMergeView` extension | `DiffEditor` component | re-architect |
| Change-tick scrollbar | custom `getChunks` plugin | overview ruler | free (with DiffEditor) |
| Blame gutter | custom `lib/blame-gutter.ts` | glyph-margin decorations | medium rewrite |

## Phased plan

1. **Spike (done).** Add Monaco behind an `editorEngine` setting. When enabled, the *plain* editor path (read + light edit of code/text files) uses Monaco; blame and markdown editing stay on CodeMirror. This answered the real questions — bundle size, worker setup in the Electron + Vite build, and how it feels — without destabilizing the working editor.
2. **Diff (done).** When the Monaco engine is on, the "show changed files" review path renders a Monaco inline `DiffEditor` (working tree vs git HEAD, modified side editable) instead of CodeMirror's `unifiedMergeView`. Change positions come from Monaco's overview ruler rather than the custom change-tick plugin. A file with no HEAD baseline (untracked/new) falls back to the plain Monaco editor, matching the CodeMirror behavior. The CodeMirror merge path is untouched and still used when the engine is `codemirror`. The diff also has a toolbar toggle to collapse unchanged regions (Monaco `hideUnchangedRegions`, configurable context lines via `diffContextLines` setting) and an inline/side-by-side toggle.
3. **Blame (done).** When the Monaco engine is on, the blame toggle renders per-line blame as injected `before` text on each line (`lib/monaco-blame.ts`) instead of a CodeMirror gutter — Monaco has no rich left-gutter API. SHA · initials · relative-date in a fixed-width column, repeated-SHA hidden Fork-style, full author/summary on hover. Clicking a row maps the click point back to a line → SHA and opens that commit. Date/initials formatting is shared with the CodeMirror gutter via `lib/blame-format.ts`. Blame on the Monaco *diff* editor is not wired (blame shows only on the plain editor). 
4. **Sticky scroll (done).** `MonacoFileEditor` enables Monaco's native `stickyScroll`. `lib/sticky-scroll.ts` is still used by the CodeMirror path and stays until that path is removed.
5. **Markdown edit mode (done in FileExplorer).** Markdown files' *edit* mode uses Monaco (markdown language) when the engine is on; the rendered preview (react-markdown) and the view/edit toggle are unchanged. `ReadmeViewer.tsx` is currently dead code (imported nowhere — markdown viewing/editing flows through `FileExplorer`), so it was left on CodeMirror; convert it if it's ever remounted.
6. **Cleanup.** Remove `@codemirror/*` deps and `.cm-*` CSS once nothing uses them. Still blocked: the `codemirror` engine remains the default, so both editors ship.

If the spike shows the bundle cost or feel isn't worth it, we stop at step 1 (or revert it) with no harm done — CodeMirror is untouched as the default.

## Spike scope (what's actually wired)

- A `monaco-editor` dependency and Vite worker setup.
- An `editorEngine: 'codemirror' | 'monaco'` setting (default `codemirror`), toggleable in Settings.
- A self-contained `MonacoFileEditor` component handling content, syntax highlighting, save, and dirty tracking.
- `FileExplorer` renders it instead of the CodeMirror host for plain files when the setting is `monaco`; everything else (diff, markdown view, images, blame) is unchanged.

The spike has since grown past its original scope — inline diff, blame, and markdown editing now run on Monaco too when the engine is on (see the phased plan above). Still on CodeMirror in Monaco mode: nothing in `FileExplorer` of consequence; `ReadmeViewer` is dead code and untouched.
