import * as monaco from 'monaco-editor';
import { scanConflicts, resolutionLines, regionsFromBlocks, hasConflictMarkers, type HunkDecision, type MergeRegion } from './conflict-parse';

// ── Shared conflict-region line decorations ───────────────────────
//
// Used by both the 3-way merge editor's Result pane and the normal
// file editor (so toggling 3-way off keeps the regions colored). ours =
// green, theirs = blue, base = dim, marker lines dimmed.
export function buildConflictLineDecorations(regions: MergeRegion[]): monaco.editor.IModelDeltaDecoration[] {
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  const lineDeco = (from: number, to: number, className: string) => {
    if (from > to) return;
    decos.push({ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className } });
  };
  for (const r of regions) {
    if (r.oursRange) lineDeco(r.oursRange[0], r.oursRange[1], 'merge-ours-line');
    if (r.theirsRange) lineDeco(r.theirsRange[0], r.theirsRange[1], 'merge-theirs-line');
    if (r.baseRange) lineDeco(r.baseRange[0], r.baseRange[1], 'merge-base-line');
    for (const m of r.markerLines) lineDeco(m, m, 'merge-marker-line');
  }
  return decos;
}

/** Paint conflict regions on a model and keep them in sync as it edits.
 * For the plain file editor (the 3-way pane manages its own). */
export function registerConflictDecorations(model: monaco.editor.ITextModel): monaco.IDisposable {
  let ids: string[] = [];
  const apply = () => {
    const regions = regionsFromBlocks(scanConflicts(model.getValue()));
    ids = model.deltaDecorations(ids, buildConflictLineDecorations(regions));
  };
  apply();
  const sub = model.onDidChangeContent(apply);
  return {
    dispose() {
      try { model.deltaDecorations(ids, []); } catch { /* model gone */ }
      sub.dispose();
    },
  };
}

// ── Inline conflict CodeLens (T-060) ──────────────────────────────
//
// Renders "Accept Current | Accept Incoming | Accept Both" actions
// above each conflict region in a plain file editor (the FileExplorer's
// MonacoFileEditor). Clicking edits the model in place — the editor's
// own change handler then marks the tab dirty, and the user saves +
// stages as normal (edit-only; no git side effects here).

const COMMAND_ID = 'vyb.resolveConflictRegion';
let commandRegistered = false;

/** Apply a resolution to the block that starts at `startLine` in `uriStr`. */
function ensureCommand(): void {
  if (commandRegistered) return;
  commandRegistered = true;
  monaco.editor.registerCommand(COMMAND_ID, (_accessor, uriStr: string, startLine: number, action: HunkDecision) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uriStr));
    if (!model) return;
    const block = scanConflicts(model.getValue()).find((b) => b.startLine === startLine);
    if (!block) return; // model changed out from under the lens — no-op
    const res = resolutionLines(block, action);
    const lineCount = model.getLineCount();
    let range: monaco.Range;
    let text: string;
    if (block.endLine < lineCount) {
      // Replace the block AND its trailing newline so an empty side
      // doesn't leave a blank line behind.
      range = new monaco.Range(block.startLine, 1, block.endLine + 1, 1);
      text = res.length ? res.join('\n') + '\n' : '';
    } else {
      range = new monaco.Range(block.startLine, 1, block.endLine, model.getLineMaxColumn(block.endLine));
      text = res.join('\n');
    }
    // pushEditOperations keeps the change on the model's undo stack.
    model.pushEditOperations([], [{ range, text }], () => null);
  });
}

/** Register an inline-conflict CodeLens provider scoped to one model.
 * Returns a disposable the editor calls on unmount. */
export function registerConflictLens(model: monaco.editor.ITextModel): monaco.IDisposable {
  ensureCommand();
  const targetUri = model.uri.toString();
  // Re-provide lenses whenever this model changes (so they refresh /
  // disappear as regions are resolved). The CodeLensProvider's onDidChange
  // event carries the provider itself, so the emitter is typed to it.
  const onDidChange = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: onDidChange.event,
    provideCodeLenses: (m) => {
      // Scope strictly to our model, and bail cheaply on clean files.
      if (m.uri.toString() !== targetUri) return { lenses: [], dispose() { /* no-op */ } };
      const text = m.getValue();
      if (!hasConflictMarkers(text)) return { lenses: [], dispose() { /* no-op */ } };
      const lenses: monaco.languages.CodeLens[] = [];
      for (const b of scanConflicts(text)) {
        const range = new monaco.Range(b.startLine, 1, b.startLine, 1);
        lenses.push({ range, command: { id: COMMAND_ID, title: 'Accept Current', arguments: [targetUri, b.startLine, 'ours'] } });
        lenses.push({ range, command: { id: COMMAND_ID, title: 'Accept Incoming', arguments: [targetUri, b.startLine, 'theirs'] } });
        lenses.push({ range, command: { id: COMMAND_ID, title: 'Accept Both', arguments: [targetUri, b.startLine, 'both-ot'] } });
      }
      return { lenses, dispose() { /* no-op */ } };
    },
  };
  const contentSub = model.onDidChangeContent(() => onDidChange.fire(provider));
  const providerSub = monaco.languages.registerCodeLensProvider(model.getLanguageId(), provider);

  return {
    dispose() {
      contentSub.dispose();
      providerSub.dispose();
      onDidChange.dispose();
    },
  };
}
