import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import '../lib/monaco-setup'; // side effect: wire workers before any editor is created
import type { EditorStatusInfo } from './MonacoFileEditor';

interface Props {
  /** Absolute path of the file being diffed. Used only to build stable
   * in-memory model URIs (NOT a file:// uri, to avoid clashing with the
   * plain MonacoFileEditor's model for the same path). */
  path: string;
  /** Baseline content (the file at git HEAD) — the left/original side. */
  original: string;
  /** Working-tree content — the right/modified side. Editable. */
  modified: string;
  language: string;
  fontSize: number;
  /** false = inline (single column); true = side-by-side (two files).
   * Applied live via updateOptions — no remount. */
  sideBySide: boolean;
  /** When true, collapse unchanged regions to a few context lines
   * around each change so only the touched sections show. */
  hideUnchanged: boolean;
  /** Context lines kept on each side of a change while collapsed. */
  contextLines: number;
  /** Fired on edits to the modified side with the current text + whether
   * it differs from `savedContent`. Drives the parent's modified-tab set. */
  onChange: (content: string, isDirty: boolean) => void;
  /** Last-saved content, the dirty baseline (see MonacoFileEditor). */
  savedContent: string;
  /** Cmd/Ctrl+S inside the editor. */
  onSave: () => void;
  /** Cmd+= / Cmd++ grow, Cmd+- shrink, Cmd+0 reset the editor font size
   * (delegated to the host so it persists in settings). */
  onAdjustFontSize?: (delta: number) => void;
  /** Cursor + EOL info for the host's status bar (tracks the editable
   * modified side). */
  onStatusInfo?: (info: EditorStatusInfo) => void;
  /** One-shot request to move the caret (modified side) to a 1-based
   * line and scroll it into view — see MonacoFileEditor.gotoLine. */
  gotoLine?: { line: number; nonce: number } | null;
}

/**
 * Monaco diff editor for the "show changed files" review path. Renders
 * the working tree against its git-HEAD baseline as an inline diff, with
 * the modified side editable so the same edit/save/dirty contract as the
 * plain editor holds. Replaces CodeMirror's unifiedMergeView when the
 * Monaco engine is selected; the change-tick scrollbar is replaced by
 * Monaco's built-in overview ruler.
 */
export function MonacoDiffEditor({
  path, original, modified, savedContent, language, fontSize, sideBySide, hideUnchanged, contextLines, onChange, onSave, onAdjustFontSize, onStatusInfo, gotoLine,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  // Bumped when the working file is reloaded externally (agent edit), to
  // force a full remount so the diff rebuilds with "hide unchanged regions"
  // re-applied. Not bumped on user typing, so editing keeps cursor/scroll.
  const [reloadNonce, setReloadNonce] = useState(0);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onAdjustFontSizeRef = useRef(onAdjustFontSize);
  const onStatusInfoRef = useRef(onStatusInfo);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onAdjustFontSizeRef.current = onAdjustFontSize;
  onStatusInfoRef.current = onStatusInfo;
  const baselineRef = useRef(savedContent);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // In-memory uris keyed by path + side so they're stable across
    // mounts and never collide with the plain editor's file:// model.
    const origUri = monaco.Uri.parse(`inmemory://diff-orig/${path}`);
    const modUri = monaco.Uri.parse(`inmemory://diff-mod/${path}`);
    const originalModel =
      monaco.editor.getModel(origUri) ?? monaco.editor.createModel(original, language, origUri);
    const modifiedModel =
      monaco.editor.getModel(modUri) ?? monaco.editor.createModel(modified, language, modUri);
    if (originalModel.getValue() !== original) originalModel.setValue(original);
    if (modifiedModel.getValue() !== modified) modifiedModel.setValue(modified);
    monaco.editor.setModelLanguage(originalModel, language);
    monaco.editor.setModelLanguage(modifiedModel, language);

    const diff = monaco.editor.createDiffEditor(host, {
      theme: 'vs-dark',
      renderSideBySide: sideBySide, // false = inline (default), true = two files
      // Monaco otherwise force-collapses side-by-side to inline when the
      // pane is narrower than ~900px (renderSideBySideInlineBreakpoint).
      // The file pane is usually below that, which would make the toggle
      // appear to do nothing. Disable the auto-collapse so the user's
      // choice is always honored.
      useInlineViewWhenSpaceIsLimited: false,
      originalEditable: false,     // baseline is read-only
      readOnly: false,             // modified side is editable
      fontSize,
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,   // change positions on the scrollbar (replaces custom ticks)
      // Collapse runs of unchanged lines down to a few context lines
      // around each change, so the reviewer sees only what was touched.
      hideUnchangedRegions: {
        enabled: hideUnchanged,
        contextLineCount: contextLines,
        minimumLineCount: contextLines,
        revealLineCount: 20,
      },
      // Hygiene defaults — match MonacoFileEditor (the modified side is
      // an ordinary editable buffer).
      bracketPairColorization: { enabled: true },
      guides: { indentation: true },
    });
    diff.setModel({ original: originalModel, modified: modifiedModel });
    diffRef.current = diff;

    const changeSub = modifiedModel.onDidChangeContent(() => {
      const value = modifiedModel.getValue();
      onChangeRef.current(value, value !== baselineRef.current);
    });

    // Cmd/Ctrl+S on the editable (modified) side → save.
    const modEditor = diff.getModifiedEditor();
    // wordBasedSuggestions isn't a diff-editor construction option —
    // apply it to the editable side directly.
    modEditor.updateOptions({ wordBasedSuggestions: 'currentDocument' });
    modEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSaveRef.current(),
    );

    // Status-bar feed (Ln/Col + EOL of the working-tree side).
    const emitStatus = (line: number, column: number) =>
      onStatusInfoRef.current?.({ line, column, eol: modifiedModel.getEOL() === '\r\n' ? 'CRLF' : 'LF' });
    emitStatus(1, 1);
    const cursorSub = modEditor.onDidChangeCursorPosition((e) =>
      emitStatus(e.position.lineNumber, e.position.column));
    // Font-size zoom (parity with the plain editor / CodeMirror).
    const adjustFont = (d: number) => onAdjustFontSizeRef.current?.(d);
    modEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal, () => adjustFont(1));
    modEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Equal, () => adjustFont(1));
    modEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus, () => adjustFont(-1));
    modEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0, () => adjustFont(0));

    // Clipboard comes from the native Edit-menu roles (focus-aware; see
    // main.ts) — Monaco handles copy/cut/paste DOM events itself.

    return () => {
      changeSub.dispose();
      cursorSub.dispose();
      diff.dispose();
      diffRef.current = null;
      try { originalModel.dispose(); } catch { /* gone */ }
      try { modifiedModel.dispose(); } catch { /* gone */ }
    };
    // Remount when the file, language, baseline (HEAD), or an external
    // reload (reloadNonce) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language, original, reloadNonce]);

  useEffect(() => {
    diffRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Jump to a requested line on the editable (modified) side — Find-in-
  // Files result clicks land here when the file opens in change mode.
  // Runs after the mount effect, and again on reloadNonce remounts so the
  // reveal survives a same-commit external reload.
  useEffect(() => {
    if (!gotoLine) return;
    const ed = diffRef.current?.getModifiedEditor();
    const model = diffRef.current?.getModel()?.modified;
    if (!ed || !model) return;
    const line = Math.min(model.getLineCount(), Math.max(1, gotoLine.line));
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }, [gotoLine, reloadNonce]);

  // Live-follow the working tree. When the `modified` prop diverges from
  // the live model, the host reloaded the file externally (an agent edited
  // it on disk) — re-baseline so it isn't flagged dirty, then bump
  // reloadNonce to force a full remount. The remount is what makes the
  // rebuilt diff honor "hide unchanged regions"; a plain setValue leaves
  // the regions expanded and re-applying the option is a Monaco no-op.
  // User typing keeps the model in sync with `modified`, so this never
  // fires mid-edit (cursor/scroll are preserved while you type).
  useEffect(() => {
    const model = diffRef.current?.getModel()?.modified;
    if (model && model.getValue() !== modified) {
      baselineRef.current = savedContent;
      setReloadNonce((n) => n + 1);
    }
  }, [modified, savedContent]);

  // Live-switch inline <-> side-by-side without remounting. Re-assert
  // useInlineViewWhenSpaceIsLimited so a narrow pane can't override the
  // explicit side-by-side choice.
  useEffect(() => {
    diffRef.current?.updateOptions({
      renderSideBySide: sideBySide,
      useInlineViewWhenSpaceIsLimited: false,
    });
  }, [sideBySide]);

  // Live-toggle collapse of unchanged regions without remounting.
  useEffect(() => {
    diffRef.current?.updateOptions({
      hideUnchangedRegions: {
        enabled: hideUnchanged,
        contextLineCount: contextLines,
        minimumLineCount: contextLines,
        revealLineCount: 20,
      },
    });
  }, [hideUnchanged, contextLines]);

  // Re-baseline dirty tracking after a save / external reload.
  useEffect(() => {
    baselineRef.current = savedContent;
  }, [savedContent]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
