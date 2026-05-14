import { ViewPlugin, ViewUpdate, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

// ── Sticky scroll (T-046) ──────────────────────────────────────────
//
// CodeMirror ViewPlugin that pins the "currently-enclosing scope"
// declaration lines at the top of the editor pane while you scroll.
// Walks up the Lezer syntax tree from the viewport's top line and
// collects function / class / method / heading nodes, capped at
// three rows deep so deeply nested code doesn't fill the screen.
//
// Supported across whatever the language extensions registered with
// the editor expose: lang-javascript/lang-python both produce node
// types that our `isScopeNode` matcher recognises. For languages
// without those nodes (plain text, markdown's own structure) the
// plugin no-ops — the overlay stays empty and invisible.

const SCOPE_NODE_TYPES = new Set([
  // JS / TS
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunction',
  'MethodDeclaration',
  'ClassDeclaration',
  'ClassExpression',
  'InterfaceDeclaration',
  'EnumDeclaration',
  'NamespaceDeclaration',
  // Python (lang-python)
  'FunctionDefinition',
  'ClassDefinition',
  'AsyncFunctionDefinition',
  // Markdown — pick up section headings as scope rows.
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
]);

interface ScopeRow {
  line: number;       // 1-based
  text: string;
}

function isScopeNode(name: string): boolean {
  return SCOPE_NODE_TYPES.has(name);
}

function collectScopes(view: EditorView, maxDepth = 3): ScopeRow[] {
  const top = view.scrollDOM.scrollTop;
  if (top <= 0) return [];
  // The block at the visual top of the viewport. `lineBlockAtHeight`
  // gives us the line that's currently scrolled to the top of the
  // visible region.
  let block;
  try { block = view.lineBlockAtHeight(top); } catch { return []; }
  if (!block) return [];
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  // Top visible line number (1-based) — anything strictly above this
  // counts as scrolled-off-screen and is fair game for the sticky
  // overlay; anything at or below is already on screen so we skip.
  const topLineNumber = doc.lineAt(block.from).number;
  let node: SyntaxNode | null = tree.resolveInner(block.from, 1);
  const seenLines = new Set<number>();
  const out: ScopeRow[] = [];
  while (node && out.length < maxDepth) {
    if (isScopeNode(node.type.name)) {
      const declLine = doc.lineAt(node.from).number;
      if (declLine < topLineNumber && !seenLines.has(declLine)) {
        seenLines.add(declLine);
        const lineFrom = doc.line(declLine).from;
        const lineTo = doc.line(declLine).to;
        const text = doc.sliceString(lineFrom, lineTo);
        out.unshift({ line: declLine, text: text.length > 200 ? text.slice(0, 200) + '…' : text });
      }
    }
    node = node.parent;
  }
  return out;
}

export function stickyScroll(): Extension {
  const plugin = ViewPlugin.fromClass(class {
    dom: HTMLElement;
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.dom = document.createElement('div');
      this.dom.className = 'cm-sticky-scroll';
      // Append to the editor root rather than scrollDOM so the
      // overlay's position is fixed relative to the editor pane,
      // not the scrolled content.
      view.dom.appendChild(this.dom);
      this.render();
      // Sticky-scroll content also has to refresh on raw scroll
      // events — `update()` only fires on doc / viewport changes,
      // and pure scrolls within the viewport don't always trigger
      // viewportChanged. Attach a passive scroll listener to the
      // scroller and re-render then.
      this.scrollHandler = () => this.render();
      view.scrollDOM.addEventListener('scroll', this.scrollHandler, { passive: true });
    }
    scrollHandler: () => void;
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.render();
      }
    }
    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.scrollHandler);
      this.dom.remove();
    }
    render() {
      const view = this.view;
      const rows = collectScopes(view);
      if (rows.length === 0) {
        this.dom.style.display = 'none';
        this.dom.innerHTML = '';
        return;
      }
      this.dom.style.display = '';
      // Reuse children where possible to avoid layout thrash on
      // every scroll tick. Cheap text comparison gates the
      // textContent reassign.
      while (this.dom.children.length > rows.length) {
        this.dom.lastChild?.remove();
      }
      while (this.dom.children.length < rows.length) {
        const r = document.createElement('div');
        r.className = 'cm-sticky-scroll-row';
        this.dom.appendChild(r);
      }
      const children = this.dom.children;
      for (let i = 0; i < rows.length; i++) {
        const child = children[i] as HTMLElement;
        const row = rows[i];
        if (child.textContent !== row.text) child.textContent = row.text;
        child.onclick = () => {
          const pos = view.state.doc.line(row.line).from;
          view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
        };
      }
    }
  });
  return plugin;
}
