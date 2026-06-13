import { forwardRef } from 'react';
import {
  MergeResultEditor,
  type MergeResultEditorHandle,
  type MergeRegion,
  type MergeRegionAction,
} from './MergeResultEditor';
import type { EditorStatusInfo } from './MonacoFileEditor';

// ── 3-pane merge editor (T-059) ───────────────────────────────────
//
// VS Code–style layout composed from three Monaco editors (Monaco has
// no built-in 3-way merge widget): the full ours (`:2`) and theirs
// (`:3`) stage files as read-only context up top, and the editable
// Result pane below — the working-tree file with markers, where each
// conflict region gets floating Accept buttons. State (load, content,
// conflict scan, resolve, apply) all lives in ConflictResolver; this
// component is purely presentational. The result editor's ref is
// forwarded up so ConflictResolver's resolve/apply use the same handle
// it uses in the simple view.

interface MergeEditorProps {
  filePath: string;
  language: string;
  eol: '\n' | '\r\n';
  oursStage: string;
  theirsStage: string;
  oursLabel: string;
  theirsLabel: string;
  /** When true, show the common-ancestor (:1) pane between ours/theirs. */
  showBase?: boolean;
  baseStage?: string;
  fontSize?: number;
  /** 1-based line ranges in ours/theirs to highlight — the exact lines
   * each side contributes to the result. */
  oursHighlight?: [number, number][];
  theirsHighlight?: [number, number][];
  /** Live buffer — seeds the result editor (so toggling views keeps edits). */
  resultValue: string;
  regions: MergeRegion[];
  onResultChange: (value: string) => void;
  onRegionAction: (index: number, action: MergeRegionAction) => void;
  onSave: () => void;
  /** Cursor/EOL feed from the editable Result pane (status bar). */
  onStatusInfo?: (info: EditorStatusInfo) => void;
}

export const MergeEditor = forwardRef<MergeResultEditorHandle, MergeEditorProps>(function MergeEditor(
  { filePath, language, eol, oursStage, theirsStage, oursLabel, theirsLabel, showBase, baseStage, fontSize, oursHighlight, theirsHighlight, resultValue, regions, onResultChange, onRegionAction, onSave, onStatusInfo },
  ref,
) {
  return (
    <div className="merge-editor">
      <div className="merge-editor-top">
        <div className="merge-pane merge-pane-ours">
          <div className="merge-pane-head merge-pane-head-ours">
            <span className="merge-pane-dot" /> Current · {oursLabel} (HEAD)
          </div>
          <div className="merge-pane-body">
            <MergeResultEditor key={`${filePath}:ours`} initialValue={oursStage} language={language} eol={eol} fontSize={fontSize} readOnly highlightRanges={oursHighlight} highlightClassName="merge-hl-ours" />
          </div>
        </div>
        {showBase && (
          <div className="merge-pane merge-pane-base">
            <div className="merge-pane-head merge-pane-head-base">
              <span className="merge-pane-dot" /> Base · common ancestor
            </div>
            <div className="merge-pane-body">
              <MergeResultEditor key={`${filePath}:base`} initialValue={baseStage ?? ''} language={language} eol={eol} fontSize={fontSize} readOnly />
            </div>
          </div>
        )}
        <div className="merge-pane merge-pane-theirs">
          <div className="merge-pane-head merge-pane-head-theirs">
            <span className="merge-pane-dot" /> Incoming · {theirsLabel}
          </div>
          <div className="merge-pane-body">
            <MergeResultEditor key={`${filePath}:theirs`} initialValue={theirsStage} language={language} eol={eol} fontSize={fontSize} readOnly highlightRanges={theirsHighlight} highlightClassName="merge-hl-theirs" />
          </div>
        </div>
      </div>
      <div className="merge-editor-result">
        <div className="merge-pane-head merge-pane-head-result">Result — editable</div>
        <div className="merge-pane-body">
          <MergeResultEditor
            key={`${filePath}:result`}
            ref={ref}
            initialValue={resultValue}
            language={language}
            eol={eol}
            fontSize={fontSize}
            conflictRegions={regions}
            onRegionAction={onRegionAction}
            onChange={onResultChange}
            onSave={onSave}
            onStatusInfo={onStatusInfo}
          />
        </div>
      </div>
    </div>
  );
});
