import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
// ClipboardAddon removed — it intercepts Escape key, breaking vi/vim
import '@xterm/xterm/css/xterm.css';
import { Profile, AppSettings } from '../../shared/types';
import { getTerminalTheme } from '../theme';

interface TerminalPaneProps {
  profiles: Profile[];
  activeProfileId: string | null;
  initialized: Set<string>;
  hidden: boolean;
  settings: AppSettings;
  focusedPane: { pane: 'agent' | 'shell'; shellIndex: number };
  navActive: boolean;
  shellOpen: boolean;
  /** When set, the agent pane renders at this width % instead of flex: 1.
   * Used by the split-with-Files/Kanban layout to pin the agent on the
   * left while the right pane takes the remainder. Null = normal flex. */
  splitWidth?: number | null;
  /** When true, http(s) links clicked in the agent output open inside
   * the embedded Web tab (via a window event consumed by App.tsx).
   * When false, they fall through to shell.openExternal — the OS browser. */
  webEnabled?: boolean;
}

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  opened: boolean;
  ptyCreated: boolean;
  kind: 'agent' | 'shell';
  webglAddon?: WebglAddon;
  lastCols: number;
  lastRows: number;
}

// Shell-escape a file path (like VS Code does)
export function escapePathForShell(p: string): string {
  return p.replace(/([ ()[\]{}$`!#&|;'"<>\\])/g, '\\$1');
}

// Smart key event handler for xterm.js — handles Option+arrows (word nav),
// Cmd+C (copy), Cmd+V (paste) before xterm's default behavior.
// Returns false = don't let xterm process. Returns true = let xterm process.
export function makeTerminalKeyHandler(terminal: Terminal, sendInput: (data: string) => void) {
  return (e: KeyboardEvent): boolean => {
    // Only react to keydown (ignore keyup, keypress)
    if (e.type !== 'keydown') return true;

    // macOS: Option + arrow → word navigation (ESC b / ESC f)
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === 'ArrowLeft') {
        sendInput('\x1bb');
        return false;
      }
      if (e.key === 'ArrowRight') {
        sendInput('\x1bf');
        return false;
      }
      if (e.key === 'Backspace') {
        // Delete previous word
        sendInput('\x1b\x7f');
        return false;
      }
    }

    // Shift+Enter → newline within the agent's input (don't submit).
    // xterm.js sends plain \r for both Enter and Shift+Enter by default, so
    // the agent CLI can't tell them apart. We send Claude's documented
    // line-continuation sequence — literal backslash + carriage return —
    // which works regardless of whether the agent's terminal parser has
    // modifyOtherKeys / CSI-u enabled.
    //
    // preventDefault() is critical: returning false blocks xterm.js from
    // processing the key, but xterm's hidden input textarea still receives
    // the browser-default Shift+Enter, inserts a newline, fires `input`,
    // and that newline is forwarded to the PTY as a stray `\r` that
    // immediately submits. Without preventDefault, every Shift+Enter after
    // the first becomes a plain Enter.
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      sendInput('\\\r');
      return false;
    }

    // Cmd+C (macOS) / Ctrl+Shift+C (linux/win) → copy selection if any
    if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && (e.key === 'c' || e.key === 'C')) {
      const sel = terminal.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel);
        return false;
      }
      // No selection — let the key through (Ctrl+C = SIGINT)
    }

    // Cmd+V (macOS) / Ctrl+Shift+V (linux/win) → paste clipboard
    if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then((text) => {
        if (text) sendInput(text);
      }).catch(() => { /* clipboard blocked */ });
      return false;
    }

    // Cmd+A → select all in terminal
    if (e.metaKey && (e.key === 'a' || e.key === 'A')) {
      terminal.selectAll();
      return false;
    }

    return true;
  };
}

// Attach native DOM drag-and-drop to a terminal element.
// Pastes shell-escaped file paths into the terminal on drop.
export function setupTerminalDrop(
  element: HTMLElement,
  sendInput: (data: string) => void,
): () => void {
  let dragCounter = 0;

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    element.classList.add('terminal-drop-active');
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      element.classList.remove('terminal-drop-active');
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    element.classList.remove('terminal-drop-active');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const p = window.api.getPathForFile(files[i]);
        if (p) paths.push(escapePathForShell(p));
      } catch {
        // fallback: try deprecated .path
        const p = (files[i] as unknown as { path?: string }).path;
        if (p) paths.push(escapePathForShell(p));
      }
    }
    if (paths.length > 0) {
      sendInput(paths.join(' '));
    }
  };

  element.addEventListener('dragenter', onDragEnter);
  element.addEventListener('dragover', onDragOver);
  element.addEventListener('dragleave', onDragLeave);
  element.addEventListener('drop', onDrop);

  return () => {
    element.removeEventListener('dragenter', onDragEnter);
    element.removeEventListener('dragover', onDragOver);
    element.removeEventListener('dragleave', onDragLeave);
    element.removeEventListener('drop', onDrop);
  };
}

// Debounced PTY resize — xterm.js reflows text immediately via fitAddon.fit(),
// but we delay telling the PTY (SIGWINCH) by 200ms to batch rapid resize events.
// This prevents TUI apps like Claude Code from redrawing their full conversation
// on every pixel of a window drag.
const resizeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const lastDims: Map<string, { cols: number; rows: number }> = new Map();

// Minimum sensible terminal dimensions. Anything smaller is almost certainly
// a transient mid-layout fit (e.g. parent grid still resizing after a Kanban
// overlay collapsed), and would leave Claude / Codex / Gemini rendering all
// their output at ~8 cols even after the layout settles.
const MIN_USABLE_COLS = 20;
const MIN_USABLE_ROWS = 5;

export function debouncedPtyResize(terminalId: string, cols: number, rows: number): void {
  // Reject obviously-broken sizes from a transient layout fit. xterm.js will
  // produce another (correct) fit shortly; this just keeps the PTY from being
  // locked at 8 cols until the user manually resizes the window.
  if (cols < MIN_USABLE_COLS || rows < MIN_USABLE_ROWS) return;

  const prev = lastDims.get(terminalId);
  if (prev && prev.cols === cols && prev.rows === rows) return;
  lastDims.set(terminalId, { cols, rows });

  const existing = resizeTimers.get(terminalId);
  if (existing) clearTimeout(existing);

  resizeTimers.set(terminalId, setTimeout(() => {
    resizeTimers.delete(terminalId);
    window.api.resizeTerminal(terminalId, cols, rows);
  }, 200));
}

function resizeIfChanged(profileId: string, instance: TerminalInstance): void {
  const cols = instance.terminal.cols;
  const rows = instance.terminal.rows;
  if (cols === instance.lastCols && rows === instance.lastRows) return;
  instance.lastCols = cols;
  instance.lastRows = rows;
  debouncedPtyResize(profileId, cols, rows);
}

function createTerminalInstance(
  container: HTMLElement,
  onData: (data: string) => void,
  fontSize: number,
  theme: ReturnType<typeof getTerminalTheme>,
  kind: 'agent' | 'shell',
  fontWeight: number,
  fontWeightBold: number,
): TerminalInstance {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontWeight: fontWeight as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
    fontWeightBold: fontWeightBold as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
    theme,
    allowProposedApi: true,
    // macOS Option key acts as Meta — enables Option+←/→ for word navigation
    macOptionIsMeta: false,
    macOptionClickForcesSelection: false,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const element = document.createElement('div');
  element.className = 'terminal-instance';
  element.style.display = 'none';
  // Inset 8px from each edge of the parent pane so xterm content has breathing
  // room from the toolbar above and the resize handle below, instead of the
  // first/last row visually touching the divider.
  element.style.position = 'absolute';
  element.style.top = '8px';
  element.style.left = '8px';
  element.style.right = '8px';
  element.style.bottom = '8px';

  container.appendChild(element);
  terminal.onData(onData);

  return { terminal, fitAddon, element, opened: false, ptyCreated: false, kind, lastCols: 0, lastRows: 0 };
}

// Match file-ish tokens in a terminal line. A match must contain a file
// extension (1-8 chars). Path prefix is optional. Optional trailing
// :line or :line:col suffix is captured so we can strip it server-side.
// We deliberately don't include `:` inside the path part so URLs like
// `https://host/path` don't slip through the filename matcher.
const FILE_TOKEN_RE = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?(?![A-Za-z0-9])/g;

function getBufferLine(terminal: Terminal, bufferLineNumber: number): string {
  // bufferLineNumber from xterm's link provider is 1-based.
  const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
  return line ? line.translateToString(true) : '';
}

function registerFileLinkProvider(
  terminal: Terminal,
  workingDirectory: string,
): void {
  terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const lineText = getBufferLine(terminal, bufferLineNumber);
      if (!lineText) {
        callback(undefined);
        return;
      }

      const links: {
        range: { start: { x: number; y: number }; end: { x: number; y: number } };
        text: string;
        activate: (event: MouseEvent, text: string) => void;
      }[] = [];

      const re = new RegExp(FILE_TOKEN_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText)) !== null) {
        const text = m[0];
        const start = m.index;

        // Skip URLs — if "://" appears in the few chars before the match,
        // this token is the path/host portion of a URL and WebLinksAddon
        // already owns it.
        const lookback = lineText.slice(Math.max(0, start - 3), start);
        if (lookback.includes('://')) continue;

        // xterm ranges are 1-based and inclusive on both ends.
        links.push({
          range: {
            start: { x: start + 1, y: bufferLineNumber },
            end: { x: start + text.length, y: bufferLineNumber },
          },
          text,
          activate: (_event, linkText) => {
            window.api.resolveFilePath(workingDirectory, linkText).then((resolved) => {
              if (resolved) {
                window.dispatchEvent(
                  new CustomEvent('open-file-in-explorer', { detail: { path: resolved } }),
                );
              }
            });
          },
        });
      }

      callback(links);
    },
  });
}

function openTerminal(
  instance: TerminalInstance,
  gpuMode: string,
  profileId: string,
  workingDirectory: string,
  webEnabledRef: { current: boolean },
): void {
  if (instance.opened) return;
  instance.opened = true;
  instance.element.style.display = 'block';
  instance.terminal.open(instance.element);
  // Attach smart key handler — handles Option+arrows (word nav), Cmd+C/V (copy/paste)
  const sendInput = (data: string) => window.api.sendInput(profileId, data);
  instance.terminal.attachCustomKeyEventHandler(
    makeTerminalKeyHandler(instance.terminal, sendInput),
  );
  // Click-handler for http(s) URLs in agent output. Route depends on the
  // Web function flag at click-time (mirrored via the ref so toggling the
  // flag is picked up without rebuilding the xterm instance):
  //   Web ON  → dispatch open-url-in-browser, consumed by App.tsx which
  //             switches to the Web tab and navigates the embedded view.
  //   Web OFF → shell.openExternal via window.api.openUrl (OS browser).
  instance.terminal.loadAddon(
    new WebLinksAddon((_event, uri) => {
      if (webEnabledRef.current) {
        window.dispatchEvent(new CustomEvent('open-url-in-browser', { detail: { url: uri } }));
      } else {
        window.api.openUrl(uri);
      }
    }),
  );
  // File-token link provider — clicking a file path in agent output
  // resolves it (BFS in main if no path given) and opens it in the
  // Files pane via a window-level event.
  if (workingDirectory) {
    registerFileLinkProvider(instance.terminal, workingDirectory);
  }
  activateWebgl(instance, gpuMode);
  // Attach native drop handler to the xterm.js element
  setupTerminalDrop(instance.element, sendInput);
}

function activateWebgl(instance: TerminalInstance, mode: string): void {
  if (mode === 'off' || mode === 'canvas') {
    // eslint-disable-next-line no-console
    console.info(`[xterm] renderer=${mode === 'off' ? 'dom' : 'canvas'} (gpuAcceleration=${mode})`);
    return;
  }
  if (instance.webglAddon) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      // eslint-disable-next-line no-console
      console.warn('[xterm] WebGL context lost — falling back to canvas');
      addon.dispose();
      instance.webglAddon = undefined;
    });
    instance.terminal.loadAddon(addon);
    instance.webglAddon = addon;
    // eslint-disable-next-line no-console
    console.info('[xterm] renderer=webgl');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[xterm] WebGL unavailable, falling back to canvas:', err);
  }
}

function deactivateWebgl(instance: TerminalInstance): void {
  if (instance.webglAddon) {
    instance.webglAddon.dispose();
    instance.webglAddon = undefined;
  }
}

export function TerminalPane({
  profiles,
  activeProfileId,
  initialized,
  hidden,
  settings,
  focusedPane,
  navActive,
  shellOpen,
  splitWidth = null,
  webEnabled = false,
}: TerminalPaneProps) {
  // Mirror webEnabled into a ref so the WebLinksAddon callback (captured
  // once per agent terminal at openTerminal time) reads the latest value
  // instead of the one in scope when the addon was attached.
  const webEnabledRef = useRef(webEnabled);
  webEnabledRef.current = webEnabled;
  const agentContainerRef = useRef<HTMLDivElement>(null);
  const agentTerminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const dataUnsubRef = useRef<(() => void) | null>(null);

  // Route incoming data to agent terminals
  useEffect(() => {
    dataUnsubRef.current = window.api.onTerminalData(({ profileId, data }) => {
      const agentInst = agentTerminalsRef.current.get(profileId);
      if (agentInst) {
        // Pass an ACK callback to xterm — fires only after the parser has
        // actually consumed the chunk, not when the IPC arrives. This makes
        // the main-process flow-control watermark reflect real renderer load
        // and pauses forwarding when xterm falls behind.
        const len = data.length;
        agentInst.terminal.write(data, () => {
          window.api.ackTerminalData(profileId, len);
        });
      }
      // Shell terminals are handled by ShellPane's own listener
    });

    return () => {
      dataUnsubRef.current?.();
      agentTerminalsRef.current.forEach((inst) => inst.terminal.dispose());
      agentTerminalsRef.current.clear();
    };
  }, []);

  // Apply settings changes to agent terminals
  useEffect(() => {
    const theme = getTerminalTheme(settings.baseHue, settings.darkness, settings.textLightness);
    agentTerminalsRef.current.forEach((instance) => {
      instance.terminal.options.fontSize = settings.agentFontSize;
      instance.terminal.options.fontWeight = settings.agentFontWeight as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
      instance.terminal.options.fontWeightBold = settings.agentFontWeightBold as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
      instance.terminal.options.theme = theme;
      if (instance.opened) instance.fitAddon.fit();
    });
  }, [settings.baseHue, settings.darkness, settings.agentFontSize, settings.agentFontWeight, settings.agentFontWeightBold]);

  // Create xterm.js instances for initialized profiles, dispose removed ones
  useEffect(() => {
    const theme = getTerminalTheme(settings.baseHue, settings.darkness, settings.textLightness);

    // Dispose terminals that are no longer in the initialized set
    for (const [profileId, instance] of agentTerminalsRef.current.entries()) {
      if (!initialized.has(profileId)) {
        deactivateWebgl(instance);
        instance.terminal.dispose();
        instance.element.remove();
        agentTerminalsRef.current.delete(profileId);
      }
    }

    // Create terminals for newly initialized profiles
    for (const profileId of initialized) {
      if (agentTerminalsRef.current.has(profileId)) continue;
      if (!agentContainerRef.current) continue;

      const instance = createTerminalInstance(
        agentContainerRef.current,
        (data) => window.api.sendInput(profileId, data),
        settings.agentFontSize,
        theme,
        'agent',
        settings.agentFontWeight,
        settings.agentFontWeightBold,
      );
      agentTerminalsRef.current.set(profileId, instance);
    }
  }, [initialized, settings.agentFontSize, settings.baseHue]);

  // Show/hide agent terminals
  useEffect(() => {
    if (hidden) {
      agentTerminalsRef.current.forEach((instance) => {
        instance.element.style.display = 'none';
        deactivateWebgl(instance);
      });
      return;
    }

    agentTerminalsRef.current.forEach((instance, id) => {
      if (id === activeProfileId) {
        const profileForOpen = profiles.find((p) => p.id === id);
        openTerminal(
          instance,
          settings.gpuAcceleration,
          id,
          profileForOpen?.workingDirectory ?? '',
          webEnabledRef,
        );
        instance.element.style.display = 'block';
        activateWebgl(instance, settings.gpuAcceleration);

        requestAnimationFrame(() => {
          // Don't fit before the parent grid has settled — a fit on a half-
          // sized container locks cols at a tiny value and the agent will
          // render all subsequent output at that width.
          const ac = agentContainerRef.current;
          if (!ac || ac.clientWidth < 100 || ac.clientHeight < 60) return;
          instance.fitAddon.fit();
          instance.terminal.focus();

          if (!instance.ptyCreated) {
            instance.ptyCreated = true;
            const profile = profiles.find((p) => p.id === id);
            if (profile) {
              window.api.createTerminal(id, profile).then(() => {
                instance.lastCols = instance.terminal.cols;
                instance.lastRows = instance.terminal.rows;
                window.api.resizeTerminal(id, instance.terminal.cols, instance.terminal.rows);
              });
            }
          } else {
            // Debounced resize — only sends to PTY if dimensions actually changed
            resizeIfChanged(id, instance);
          }
        });
      } else {
        instance.element.style.display = 'none';
        deactivateWebgl(instance);
      }
    });
  }, [activeProfileId, initialized, shellOpen, hidden, profiles]);

  // Focus the agent terminal when focusedPane switches to 'agent'
  useEffect(() => {
    if (focusedPane.pane === 'agent' && activeProfileId && !hidden) {
      const agentInst = agentTerminalsRef.current.get(activeProfileId);
      if (agentInst && agentInst.opened) {
        agentInst.terminal.focus();
      }
    }
  }, [focusedPane, activeProfileId, hidden]);

  // Refit when returning from hidden (README/Files/Kanban → terminal view).
  // Done in two passes — 50 ms catches a quickly-settled layout, 250 ms is a
  // safety net for slower transitions (e.g. an iframe-heavy Kanban tab tearing
  // down). Both honor the dimension floor so a transient mid-layout container
  // can't lock the PTY at a tiny cols value.
  useEffect(() => {
    if (hidden) return;
    const refit = () => {
      if (!activeProfileId) return;
      const agentInst = agentTerminalsRef.current.get(activeProfileId);
      if (!agentInst || !agentInst.opened) return;
      const ac = agentContainerRef.current;
      if (!ac || ac.clientWidth < 100 || ac.clientHeight < 60) return;
      agentInst.fitAddon.fit();
      resizeIfChanged(activeProfileId, agentInst);
    };
    const t1 = setTimeout(refit, 50);
    const t2 = setTimeout(refit, 250);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [hidden, activeProfileId, shellOpen]);

  // Refit agent terminals on container resize — only fires on ACTUAL size changes,
  // not on profile switch. ResizeObserver fires once on initial .observe() — skip that.
  useEffect(() => {
    const agentContainer = agentContainerRef.current;
    if (!agentContainer) return;

    let rafId: number | null = null;

    const refit = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        // Floor needs to be high enough that a transient mid-layout container
        // (e.g. just after a Kanban overlay collapsed) can't slip through and
        // lock the PTY at ~1 col. 100×60 px ≈ 12 cols × 4 rows minimum.
        if (agentContainer.clientHeight < 60 || agentContainer.clientWidth < 100) return;
        if (activeProfileId) {
          const agentInst = agentTerminalsRef.current.get(activeProfileId);
          if (agentInst && agentInst.opened && agentInst.element.style.display !== 'none') {
            agentInst.fitAddon.fit();
            resizeIfChanged(activeProfileId, agentInst);
          }
        }
      });
    };

    const observer = new ResizeObserver(refit);
    observer.observe(agentContainer);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [activeProfileId, shellOpen]);

  return (
    <div
      className="terminal-pane agent-pane"
      ref={agentContainerRef}
      style={
        hidden
          ? { display: 'none' }
          : splitWidth !== null
            ? { width: `${splitWidth}%`, flex: '0 0 auto', minHeight: 0, minWidth: 0 }
            : { flex: 1, minHeight: 0 }
      }
    >
      {!activeProfileId && (
        <div className="terminal-placeholder">Select a profile to start</div>
      )}
      {navActive && shellOpen && focusedPane.pane === 'agent' && (
        <div className="nav-pane-hint right">
          <span className="nav-arrow">&#x2192;</span>
        </div>
      )}
    </div>
  );
}
