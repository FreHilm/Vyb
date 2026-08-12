import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as monaco from 'monaco-editor';
import '../lib/monaco-setup'; // side effect: wire workers before any editor is created
import type { MergeRegion, HunkDecision } from '../lib/conflict-parse';
import { buildConflictLineDecorations } from '../lib/monaco-conflict-lens';
import type { EditorStatusInfo } from './MonacoFileEditor';

// ── Reusable editable Monaco editor for merge-conflict resolution ──
//
// Used three ways:
//   • the single-editor result pane of the conflict resolver (T-058),
//   • the editable Result pane of the 3-pane merge editor (T-059),
//   • the two read-only context panes (ours / theirs) of that 3-pane
//     editor, via `readOnly`.
//
// It owns a private in-memory model URI so it never collides with the
// FileExplorer's `file://` model for the same path, exposes a small
// imperative API so the host's accept actions can splice resolutions
// into the live text (preserving undo), and — when given
// `conflictRegions` — paints each region and floats Accept buttons on
// it via Monaco content widgets.

// Region shape + action union live in the shared parser; re-exported so
// existing consumers (MergeEditor) keep importing them from here.
export type MergeRegionAction = HunkDecision;
export type { MergeRegion };

export interface MergeResultEditorHandle {
  /** Current buffer text (with the model's EOL applied). */
  getValue: () => string;
  /** Replace the whole buffer, keeping it a single undo step + focus. */
  setValue: (text: string) => void;
  /** Scroll a 1-based line into view and place the caret there. */
  reveal: (line: number) => void;
  focus: () => void;
}

interface Props {
  /** Seeded once on mount. Re-seed by remounting (key on the file path). */
  initialValue: string;
  /** Monaco language id (from `monacoLanguageForFile`). */
  language: string;
  /** Preserve the file's line endings on save. */
  eol?: '\n' | '\r\n';
  fontSize?: number;
  readOnly?: boolean;
  /** Fires on every edit (button-driven or hand-typed) with the buffer. */
  onChange?: (value: string) => void;
  /** Cmd/Ctrl+S inside the editor. */
  onSave?: () => void;
  /** When set, each region is painted and gets floating Accept buttons. */
  conflictRegions?: MergeRegion[];
  /** Invoked when a region's Accept button is clicked. */
  onRegionAction?: (index: number, action: MergeRegionAction) => void;
  /** 1-based [from,to] line ranges to highlight (read-only side panes:
   * the exact lines this side contributes to the result). */
  highlightRanges?: [number, number][];
  /** CSS class for the highlight (e.g. 'merge-hl-ours'). */
  highlightClassName?: string;
  /** Cursor + EOL info for the host's status bar (used by the editable
   * result pane when embedded in the file editor). */
  onStatusInfo?: (info: EditorStatusInfo) => void;
}

// Monotonic so each instance gets a unique model URI.
let mergeEditorSeq = 0;

export const MergeResultEditor = forwardRef<MergeResultEditorHandle, Props>(function MergeResultEditor(
  { initialValue, language, eol = '\n', fontSize = 13, readOnly = false, onChange, onSave, conflictRegions, onRegionAction, highlightRanges, highlightClassName, onStatusInfo },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const hlDecoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onRegionActionRef = useRef(onRegionAction);
  const onStatusInfoRef = useRef(onStatusInfo);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onRegionActionRef.current = onRegionAction;
  onStatusInfoRef.current = onStatusInfo;

  useImperativeHandle(ref, () => ({
    getValue: () => modelRef.current?.getValue() ?? '',
    setValue: (text: string) => {
      const ed = editorRef.current;
      const model = modelRef.current;
      if (!ed || !model) return;
      // Full-range replace via executeEdits (not setValue) so the change
      // joins the undo stack and the editor keeps focus.
      ed.executeEdits('merge-resolve', [{ range: model.getFullModelRange(), text }]);
      ed.pushUndoStop();
    },
    reveal: (line: number) => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
      ed.focus();
    },
    focus: () => editorRef.current?.focus(),
  }), []);

  // Mount once. Props (initialValue/language/eol) are captured here; the
  // host remounts (key on file path / view) to load a different buffer.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const uri = monaco.Uri.parse(`inmemory://merge/${++mergeEditorSeq}`);
    const model = monaco.editor.createModel(initialValue, language, uri);
    model.setEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    modelRef.current = model;

    const editor = monaco.editor.create(host, {
      model,
      theme: 'vs-dark',
      fontSize,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
      // Hygiene defaults — match MonacoFileEditor.
      bracketPairColorization: { enabled: true },
      guides: { indentation: true },
      wordBasedSuggestions: 'currentDocument',
    });
    editorRef.current = editor;
    decoRef.current = editor.createDecorationsCollection();
    hlDecoRef.current = editor.createDecorationsCollection();

    const sub = model.onDidChangeContent(() => onChangeRef.current?.(model.getValue()));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.());

    // Status-bar feed (Ln/Col + EOL) — used by the result pane when this
    // editor is embedded in the FileExplorer's 3-way view.
    const emitStatus = (line: number, column: number) =>
      onStatusInfoRef.current?.({ line, column, eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF' });
    emitStatus(1, 1);
    const cursorSub = editor.onDidChangeCursorPosition((e) =>
      emitStatus(e.position.lineNumber, e.position.column));

    return () => {
      sub.dispose();
      cursorSub.dispose();
      decoRef.current?.clear();
      decoRef.current = null;
      hlDecoRef.current?.clear();
      hlDecoRef.current = null;
      editor.dispose();
      editorRef.current = null;
      try { model.dispose(); } catch { /* already disposed */ }
      modelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-apply font size without remounting.
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Read-only panes (ours / theirs / base in the merge editor) receive
  // their content asynchronously — reseed when it arrives. Editable
  // panes stay mount-once so in-progress edits are never clobbered.
  useEffect(() => {
    if (!readOnly) return;
    const model = modelRef.current;
    if (model && model.getValue() !== initialValue) model.setValue(initialValue);
  }, [initialValue, readOnly]);

  // Highlight the exact lines this side contributes to the result
  // (read-only side panes). Re-applied if the ranges/content change.
  useEffect(() => {
    const coll = hlDecoRef.current;
    if (!coll) return;
    const cls = highlightClassName ?? 'merge-hl-ours';
    const decos = (highlightRanges ?? [])
      .filter(([from, to]) => from <= to)
      .map(([from, to]) => ({
        range: new monaco.Range(from, 1, to, 1),
        options: { isWholeLine: true, className: cls },
      }));
    coll.set(decos);
  }, [highlightRanges, highlightClassName, initialValue]);

  // Paint conflict regions and float Accept buttons on each. Rebuilt
  // whenever the regions change (e.g. after resolving one). Cleanup
  // removes the previous widgets before the next set is added.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const regions = conflictRegions ?? [];
    decoRef.current?.set(buildConflictLineDecorations(regions));

    const widgets: monaco.editor.IContentWidget[] = regions.map((r) => {
      const dom = document.createElement('div');
      dom.className = 'merge-region-actions';
      const mk = (label: string, cls: string, action: MergeRegionAction) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = cls;
        b.onclick = (e) => { e.preventDefault(); onRegionActionRef.current?.(r.index, action); };
        dom.appendChild(b);
      };
      mk('Current', 'mra-ours', 'ours');
      mk('Incoming', 'mra-theirs', 'theirs');
      mk('Both ↓', 'mra-both', 'both-ot');
      mk('Both ↑', 'mra-both', 'both-to');
      return {
        getId: () => `merge-region-${r.index}`,
        getDomNode: () => dom,
        getPosition: () => ({
          position: { lineNumber: r.anchorLine, column: 1 },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            monaco.editor.ContentWidgetPositionPreference.BELOW,
          ],
        }),
      };
    });
    widgets.forEach((w) => editor.addContentWidget(w));

    return () => {
      widgets.forEach((w) => editor.removeContentWidget(w));
      decoRef.current?.set([]);
    };
  }, [conflictRegions]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
});
