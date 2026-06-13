import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MergeEditor } from './MergeEditor';
import type { MergeResultEditorHandle, MergeRegionAction } from './MergeResultEditor';
import { scanConflicts, resolutionLines, regionsFromBlocks, buildSideView, detectNewline, splitLines } from '../lib/conflict-parse';

// ── 3-way merge editor embedded in a FileExplorer tab (T-060 follow-up) ──
//
// A drop-in alternative to MonacoFileEditor for conflicted files: it
// loads ours (:2), theirs (:3) and base (:1) from the git index and
// shows the 3-pane MergeEditor, with the working-tree file (markers
// intact) as the editable Result. It mirrors MonacoFileEditor's host
// contract — `onChange(content, isDirty)` + `onSave` — so FileExplorer's
// existing dirty/save/docCache machinery drives it unchanged. Edit-only:
// saving just writes the file; staging stays in the Git panel.

interface Props {
  workingDirectory: string;
  /** Absolute path (model identity for the result editor). */
  filePath: string;
  /** Repo-relative path, for `gitShowStage`. */
  relPath: string;
  initialContent: string;
  /** Dirty baseline (last saved content). */
  savedContent: string;
  language: string;
  fontSize: number;
  showBase?: boolean;
  onChange: (content: string, isDirty: boolean) => void;
  onSave: () => void;
  /** Cursor/EOL feed from the Result pane for the editor status bar. */
  onStatusInfo?: (info: import('./MonacoFileEditor').EditorStatusInfo) => void;
}

export function ThreeWayFileEditor({
  workingDirectory, filePath, relPath, initialContent, savedContent, language, fontSize, showBase, onChange, onSave, onStatusInfo,
}: Props) {
  const [content, setContent] = useState(initialContent);
  const [baseStage, setBaseStage] = useState('');
  const [labels, setLabels] = useState<{ ours: string; theirs: string }>({ ours: 'ours', theirs: 'theirs' });
  const editorRef = useRef<MergeResultEditorHandle | null>(null);
  const reqRef = useRef(0);
  const eol = useMemo(() => detectNewline(initialContent), [initialContent]);

  // Reconstruct each side's full file + the exact conflict-line ranges
  // from the working-tree markers (no git fetch — always in sync with
  // what the result shows, and never empty due to async timing).
  const oursView = useMemo(() => buildSideView(initialContent, 'ours'), [initialContent]);
  const theirsView = useMemo(() => buildSideView(initialContent, 'theirs'), [initialContent]);

  // Base (common ancestor) still comes from the git index (:1).
  useEffect(() => {
    const id = ++reqRef.current;
    (async () => {
      const base = await window.api.gitShowStage(workingDirectory, relPath, 1);
      if (id !== reqRef.current) return;
      setBaseStage(base ?? '');
    })();
  }, [workingDirectory, relPath]);

  // Capture the marker labels once for the pane headers.
  useEffect(() => {
    const blocks = scanConflicts(initialContent);
    if (blocks.length) setLabels({ ours: blocks[0].oursLabel, theirs: blocks[0].theirsLabel });
  }, [initialContent]);

  const regions = useMemo(() => regionsFromBlocks(scanConflicts(content)), [content]);

  // Accept-button: re-scan the live buffer and splice the chosen side.
  const resolveBlock = useCallback((ordinal: number, decision: MergeRegionAction) => {
    const ed = editorRef.current;
    if (!ed) return;
    const current = ed.getValue();
    const blocks = scanConflicts(current);
    const b = blocks[ordinal];
    if (!b) return;
    const lines = splitLines(current);
    lines.splice(b.startLine - 1, b.endLine - b.startLine + 1, ...resolutionLines(b, decision));
    ed.setValue(lines.join('\n'));
  }, []);

  const handleResultChange = useCallback((value: string) => {
    setContent(value);
    onChange(value, value !== savedContent);
  }, [onChange, savedContent]);

  return (
    <div className="threeway-file-editor">
      <MergeEditor
        ref={editorRef}
        filePath={filePath}
        language={language}
        eol={eol}
        fontSize={fontSize}
        oursStage={oursView.text}
        theirsStage={theirsView.text}
        oursHighlight={oursView.ranges}
        theirsHighlight={theirsView.ranges}
        oursLabel={labels.ours}
        theirsLabel={labels.theirs}
        showBase={showBase}
        baseStage={baseStage}
        resultValue={content}
        regions={regions}
        onResultChange={handleResultChange}
        onRegionAction={resolveBlock}
        onSave={onSave}
        onStatusInfo={onStatusInfo}
      />
    </div>
  );
}
