import * as monaco from 'monaco-editor';
import type { GitBlameLine } from '../../shared/types';
import { relativeDate, authorInitials } from './blame-format';

// ── Monaco per-line blame (counterpart to lib/blame-gutter.ts) ────────
//
// Monaco has no rich left-gutter API, so we render blame as injected
// `before` text on each line: a fixed-width muted column showing
// short-SHA · initials · relative-date, Fork-style (the SHA is hidden on
// the 2nd+ line of a run attributed to the same commit). A hover tooltip
// carries the full author / summary. Clicking the column is wired up by
// the editor host (it maps the click point back to a line → SHA) — see
// MonacoFileEditor.

/** Width of the injected blame column, in `ch`. Sized to fit
 * `shortSha(7) + initials(2) + date(~4)` plus separators. */
export const BLAME_COL_CH = 17;

const ZERO_SHA = /^0+$/;

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/** Build the injected-text decorations for a blame snapshot. Returns one
 * decoration per line (range collapsed to column 1). Lines beyond the
 * blame array (e.g. unsaved appended lines) simply get no decoration. */
export function buildBlameDecorations(blame: GitBlameLine[]): monaco.editor.IModelDeltaDecoration[] {
  if (!blame || blame.length === 0) return [];
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  let prevSha = '';
  for (const entry of blame) {
    const uncommitted = ZERO_SHA.test(entry.sha);
    const showSha = !uncommitted && entry.sha !== prevSha;
    prevSha = entry.sha;

    let content: string;
    let hover: string;
    if (uncommitted) {
      content = pad('·······', BLAME_COL_CH);
      hover = 'Uncommitted change';
    } else {
      const sha = showSha ? entry.shortSha : ' '.repeat(entry.shortSha.length);
      const date = relativeDate(entry.authorTime);
      content = pad(`${sha} ${authorInitials(entry.author)} ${date}`, BLAME_COL_CH);
      hover = `${entry.shortSha} · ${entry.author} · ${relativeDate(entry.authorTime)}\n${entry.summary}`;
    }

    decorations.push({
      range: new monaco.Range(entry.lineNumber, 1, entry.lineNumber, 1),
      options: {
        // `before` injects the column at the very start of the line.
        before: {
          content,
          inlineClassName: uncommitted ? 'monaco-blame-col monaco-blame-col-uncommitted' : 'monaco-blame-col',
          inlineClassNameAffectsLetterSpacing: true,
        },
        // Hover over the line shows the full commit context.
        hoverMessage: { value: hover },
      },
    });
  }
  return decorations;
}
