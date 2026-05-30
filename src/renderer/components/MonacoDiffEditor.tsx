import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import '../lib/monaco-setup'; // side effect: wire workers before any editor is created

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
  /** Fired on edits to the modified side with the current text + whether
   * it differs from `savedContent`. Drives the parent's modified-tab set. */
  onChange: (content: string, isDirty: boolean) => void;
  /** Last-saved content, the dirty baseline (see MonacoFileEditor). */
  savedContent: string;
  /** Cmd/Ctrl+S inside the editor. */
  onSave: () => void;
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
  path, original, modified, savedContent, language, fontSize, sideBySide, onChange, onSave,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
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
    });
    diff.setModel({ original: originalModel, modified: modifiedModel });
    diffRef.current = diff;

    const changeSub = modifiedModel.onDidChangeContent(() => {
      const value = modifiedModel.getValue();
      onChangeRef.current(value, value !== baselineRef.current);
    });

    // Cmd/Ctrl+S on the editable (modified) side → save.
    diff.getModifiedEditor().addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSaveRef.current(),
    );

    return () => {
      changeSub.dispose();
      diff.dispose();
      diffRef.current = null;
      try { originalModel.dispose(); } catch { /* gone */ }
      try { modifiedModel.dispose(); } catch { /* gone */ }
    };
    // Remount when the file, language, or baseline (HEAD) changes.
  }, [path, language, original]);

  useEffect(() => {
    diffRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Live-switch inline <-> side-by-side without remounting. Re-assert
  // useInlineViewWhenSpaceIsLimited so a narrow pane can't override the
  // explicit side-by-side choice.
  useEffect(() => {
    diffRef.current?.updateOptions({
      renderSideBySide: sideBySide,
      useInlineViewWhenSpaceIsLimited: false,
    });
  }, [sideBySide]);

  // Re-baseline dirty tracking after a save / external reload.
  useEffect(() => {
    baselineRef.current = savedContent;
  }, [savedContent]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
