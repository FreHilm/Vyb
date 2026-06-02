import * as monaco from 'monaco-editor';

// Clipboard for Monaco in Electron.
//
// Vyb deliberately strips the Cocoa Edit-menu roles (Copy/Cut/Paste) so
// xterm.js can keep Cmd+C for terminal selection. Without those roles two
// things break in Monaco on macOS:
//   1. the native `copy`/`cut`/`paste` DOM events don't fire on Cmd+C/X/V, and
//   2. Monaco's built-in Paste uses `document.execCommand('paste')`, which
//      Chromium/Electron block — so even the right-click Paste no-ops.
//
// So we register our own Copy / Cut / Paste actions driven by the async
// `navigator.clipboard` API (which works in the Electron renderer). Because
// they're real editor actions with keybindings AND a context-menu group,
// they fix both the keyboard shortcuts and the right-click menu. The
// keybindings override Monaco's built-ins; the context-menu entries sit in
// the standard clipboard group.
export function installMonacoClipboard(
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.IDisposable[] {
  const copyOrCut = (cut: boolean): void => {
    const model = editor.getModel();
    const sel = editor.getSelection();
    if (!model || !sel) return;
    // No selection → act on the whole line, matching native editor behavior.
    const range = sel.isEmpty()
      ? new monaco.Range(sel.startLineNumber, 1, sel.startLineNumber + 1, 1)
      : sel;
    const text = model.getValueInRange(range);
    if (!text) return;
    navigator.clipboard.writeText(text).catch((): void => undefined);
    if (cut) {
      editor.executeEdits('vyb-clipboard', [{ range, text: '', forceMoveMarkers: true }]);
    }
  };

  const paste = async (): Promise<void> => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    const sel = editor.getSelection();
    if (!sel) return;
    editor.executeEdits('vyb-clipboard', [{ range: sel, text, forceMoveMarkers: true }]);
    editor.focus();
  };

  return [
    editor.addAction({
      id: 'vyb.clipboard.copy',
      label: 'Copy',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 1,
      run: () => copyOrCut(false),
    }),
    editor.addAction({
      id: 'vyb.clipboard.cut',
      label: 'Cut',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX],
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 2,
      run: () => copyOrCut(true),
    }),
    editor.addAction({
      id: 'vyb.clipboard.paste',
      label: 'Paste',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 3,
      run: () => paste(),
    }),
  ];
}
