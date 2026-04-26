import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
// ClipboardAddon removed — it intercepts Escape key, breaking vi/vim
import '@xterm/xterm/css/xterm.css';
import { Profile, AppSettings, ProfileMemoryMap } from '../../shared/types';
import { getTerminalTheme } from '../theme';
import { ResizeHandle } from './ResizeHandle';
import { ShellPane } from './ShellPane';

interface TerminalPaneProps {
  profiles: Profile[];
  activeProfileId: string | null;
  initialized: Set<string>;
  shellOpen: boolean;
  hidden: boolean;
  onShellExited: () => void;
  settings: AppSettings;
  onSplitChange: (percent: number) => void;
  focusedPane: { pane: 'agent' | 'shell'; shellIndex: number };
  navActive: boolean;
  onShellCountChange?: (profileId: string, count: number) => void;
  profileMemory: ProfileMemoryMap;
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

function shellId(profileId: string): string {
  return `shell:${profileId}`;
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

export function debouncedPtyResize(terminalId: string, cols: number, rows: number): void {
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
): TerminalInstance {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.position = 'absolute';
  element.style.top = '0';
  element.style.left = '0';

  container.appendChild(element);
  terminal.onData(onData);

  return { terminal, fitAddon, element, opened: false, ptyCreated: false, kind, lastCols: 0, lastRows: 0 };
}

function openTerminal(instance: TerminalInstance, gpuMode: string, profileId: string): void {
  if (instance.opened) return;
  instance.opened = true;
  instance.element.style.display = 'block';
  instance.terminal.open(instance.element);
  // Attach smart key handler — handles Option+arrows (word nav), Cmd+C/V (copy/paste)
  const sendInput = (data: string) => window.api.sendInput(profileId, data);
  instance.terminal.attachCustomKeyEventHandler(
    makeTerminalKeyHandler(instance.terminal, sendInput),
  );
  // Make http(s) URLs in agent output clickable — opens in OS default browser
  // via shell.openExternal instead of the addon's default window.open.
  instance.terminal.loadAddon(
    new WebLinksAddon((_event, uri) => {
      window.api.openUrl(uri);
    }),
  );
  activateWebgl(instance, gpuMode);
  // Attach native drop handler to the xterm.js element
  setupTerminalDrop(instance.element, sendInput);
}

function activateWebgl(instance: TerminalInstance, mode: string): void {
  if (mode === 'off' || mode === 'canvas') return;
  if (instance.webglAddon) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      instance.webglAddon = undefined;
    });
    instance.terminal.loadAddon(addon);
    instance.webglAddon = addon;
  } catch {
    // canvas fallback
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
  shellOpen,
  hidden,
  onShellExited,
  settings,
  onSplitChange,
  focusedPane,
  navActive,
  onShellCountChange,
  profileMemory,
}: TerminalPaneProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const agentContainerRef = useRef<HTMLDivElement>(null);
  const [agentPercent, setAgentPercent] = useState(settings.terminalSplitPercent);
  const agentTerminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const shellOpenedRef = useRef<Set<string>>(new Set());
  const dataUnsubRef = useRef<(() => void) | null>(null);

  // Route incoming data to agent terminals
  useEffect(() => {
    dataUnsubRef.current = window.api.onTerminalData(({ profileId, data }) => {
      const agentInst = agentTerminalsRef.current.get(profileId);
      if (agentInst) {
        agentInst.terminal.write(data);
        window.api.ackTerminalData(profileId, data.length);
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
    const theme = getTerminalTheme(settings.baseHue, settings.darkness);
    agentTerminalsRef.current.forEach((instance) => {
      instance.terminal.options.fontSize = settings.agentFontSize;
      instance.terminal.options.theme = theme;
      if (instance.opened) instance.fitAddon.fit();
    });
  }, [settings.baseHue, settings.darkness, settings.agentFontSize]);

  // Create xterm.js instances for initialized profiles, dispose removed ones
  useEffect(() => {
    const theme = getTerminalTheme(settings.baseHue, settings.darkness);

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
        openTerminal(instance, settings.gpuAcceleration, id);
        instance.element.style.display = 'block';
        activateWebgl(instance, settings.gpuAcceleration);

        requestAnimationFrame(() => {
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

  // Refit when returning from hidden (README/Files → terminal view)
  useEffect(() => {
    if (hidden) return;
    const timer = setTimeout(() => {
      if (activeProfileId) {
        const agentInst = agentTerminalsRef.current.get(activeProfileId);
        if (agentInst && agentInst.opened) {
          agentInst.fitAddon.fit();
          // Only resize PTY if dimensions truly changed (e.g. window was resized while hidden)
          resizeIfChanged(activeProfileId, agentInst);
        }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [hidden, activeProfileId, shellOpen]);

  const handleTerminalSplitResize = useCallback((delta: number) => {
    const container = splitRef.current;
    if (!container) return;
    const totalHeight = container.clientHeight;
    if (totalHeight === 0) return;
    const deltaPercent = (delta / totalHeight) * 100;
    setAgentPercent((p) => {
      const next = Math.max(20, Math.min(80, p + deltaPercent));
      onSplitChange(next);
      return next;
    });
  }, [onSplitChange]);

  // Refit agent terminals on container resize — only fires on ACTUAL size changes,
  // not on profile switch. ResizeObserver fires once on initial .observe() — skip that.
  useEffect(() => {
    const agentContainer = agentContainerRef.current;
    if (!agentContainer) return;

    let rafId: number | null = null;

    const refit = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (agentContainer.clientHeight < 10 || agentContainer.clientWidth < 10) return;
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

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  // Track which profiles have had shell opened
  useEffect(() => {
    if (shellOpen && activeProfileId) {
      shellOpenedRef.current.add(activeProfileId);
    }
  }, [shellOpen, activeProfileId]);

  const agentStyle = shellOpen
    ? { height: `${agentPercent}%` }
    : { flex: 1 };
  const shellStyle = shellOpen
    ? { height: `${100 - agentPercent}%`, display: 'block' as const }
    : { display: 'none' as const };

  return (
    <div className="terminal-split" ref={splitRef}>
      <div
        className="terminal-pane agent-pane"
        style={agentStyle}
        ref={agentContainerRef}
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
      {shellOpen && (
        <ResizeHandle direction="vertical" onResize={handleTerminalSplitResize} />
      )}
      <div className="terminal-pane shell-pane" style={shellStyle}>
        {profiles.map((p) => {
          const isVisible = shellOpen && p.id === activeProfileId && !hidden;
          const wasOpened = shellOpenedRef.current.has(p.id);
          if (!wasOpened && !isVisible) return null;
          return (
            <div
              key={p.id}
              style={{ display: isVisible ? 'block' : 'none', width: '100%', height: '100%' }}
            >
              <ShellPane
                profileId={p.id}
                workingDirectory={p.workingDirectory}
                hidden={!isVisible}
                settings={settings}
                onAllClosed={onShellExited}
                focused={isVisible && focusedPane.pane === 'shell'}
                focusedIndex={focusedPane.shellIndex}
                navActive={navActive && isVisible}
                navFocusedPane={focusedPane}
                onShellCountChange={(count) => onShellCountChange?.(p.id, count)}
                initialShellCount={profileMemory[p.id]?.shellCount || 1}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
