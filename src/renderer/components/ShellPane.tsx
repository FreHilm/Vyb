import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
// ClipboardAddon removed — it intercepts Escape key, breaking vi/vim
import '@xterm/xterm/css/xterm.css';
import { AppSettings } from '../../shared/types';
import { getShellTerminalTheme } from '../theme';
import { ResizeHandle } from './ResizeHandle';
import { setupTerminalDrop, debouncedPtyResize, makeTerminalKeyHandler } from './TerminalPane';

interface ShellPaneProps {
  profileId: string;
  workingDirectory: string;
  hidden: boolean;
  settings: AppSettings;
  onAllClosed: () => void;
  focused: boolean;
  focusedIndex: number;
  navActive: boolean;
  navFocusedPane: { pane: 'agent' | 'shell'; shellIndex: number };
  onShellCountChange?: (count: number) => void;
  initialShellCount: number;
  /** Mirrors the agent pane's behaviour: when true, clicked URLs in
   * shell output open in the in-app Web tab; when false they go to
   * the OS browser via shell.openExternal. */
  webEnabled?: boolean;
}

interface ShellInfo {
  id: string;
  ptyCreated: boolean;
}

let shellCounter = 0;

export function ShellPane({
  profileId,
  workingDirectory,
  hidden,
  settings,
  onAllClosed,
  focused,
  focusedIndex,
  navActive,
  navFocusedPane,
  onShellCountChange,
  initialShellCount,
  webEnabled = false,
}: ShellPaneProps) {
  // Mirror webEnabled into a ref so the WebLinksAddon click handler
  // (captured once at terminal-creation time) always reads the latest
  // value instead of the snapshot it had when the addon was attached.
  // Same pattern as TerminalPane.
  const webEnabledRef = useRef(webEnabled);
  webEnabledRef.current = webEnabled;
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [widths, setWidths] = useState<number[]>([]);
  const terminalsRef = useRef<Map<string, { terminal: Terminal; fitAddon: FitAddon; webglAddon?: WebglAddon }>>(new Map());
  const panelRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Visibility for the split/close hotkey captions. These are ⌃⌘ shortcuts,
  // so — unlike the nav captions (which need the nav modifier held ALONE) —
  // they should show while ⌘ is held (preview) and STAY while ⌃⌘ is held.
  // We track the live modifier state directly rather than reuse `navActive`
  // (which goes false the moment a second modifier like ⌃ joins).
  const [splitHintVisible, setSplitHintVisible] = useState(false);
  // Like the nav captions, these only appear after ⌘ has been held for 2s.
  // hintTimerRef holds the pending show timer; visibleRef mirrors the shown
  // state so the per-mousemove handler doesn't keep rescheduling once shown.
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintVisibleRef = useRef(false);
  useEffect(() => {
    const cancel = () => {
      if (hintTimerRef.current) { clearTimeout(hintTimerRef.current); hintTimerRef.current = null; }
      hintVisibleRef.current = false;
      setSplitHintVisible(false);
    };
    if (hidden) { cancel(); return; }
    // ⌘ present, and no ⇧/⌥ (those would mean a different combo). ⌃ is
    // allowed — that's the actual split modifier — so ⌘ and ⌃⌘ both qualify.
    const update = (e: KeyboardEvent | MouseEvent) => {
      const shouldShow = e.metaKey && !e.shiftKey && !e.altKey;
      if (shouldShow) {
        if (!hintTimerRef.current && !hintVisibleRef.current) {
          hintTimerRef.current = setTimeout(() => {
            hintTimerRef.current = null;
            hintVisibleRef.current = true;
            setSplitHintVisible(true);
          }, 2000);
        }
      } else {
        cancel();
      }
    };
    const onVis = () => { if (document.visibilityState !== 'visible') cancel(); };
    window.addEventListener('keydown', update, true);
    window.addEventListener('keyup', update, true);
    window.addEventListener('mousemove', update);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', update, true);
      window.removeEventListener('keyup', update, true);
      window.removeEventListener('mousemove', update);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', onVis);
      cancel();
    };
  }, [hidden]);

  // Listen for shell exits
  useEffect(() => {
    const unsub = window.api.onShellExited(({ terminalId }) => {
      const entry = terminalsRef.current.get(terminalId);
      if (entry) {
        if (entry.webglAddon) entry.webglAddon.dispose();
        entry.terminal.dispose();
        terminalsRef.current.delete(terminalId);
      }

      setShells((prev) => {
        const next = prev.filter((s) => s.id !== terminalId);
        if (next.length === 0) onAllClosed();
        else {
          const each = 100 / next.length;
          setWidths(next.map(() => each));
        }
        return next;
      });
    });

    return () => unsub();
  }, [onAllClosed]);

  // Release WebGL contexts when hidden, reactivate when visible
  useEffect(() => {
    terminalsRef.current.forEach((entry) => {
      if (hidden) {
        if (entry.webglAddon) {
          entry.webglAddon.dispose();
          entry.webglAddon = undefined;
        }
      } else if (!entry.webglAddon && settings.gpuAcceleration === 'auto') {
        try {
          const addon = new WebglAddon();
          addon.onContextLoss(() => {
            addon.dispose();
            entry.webglAddon = undefined;
          });
          entry.terminal.loadAddon(addon);
          entry.webglAddon = addon;
        } catch { /* canvas fallback */ }
      }
    });
  }, [hidden]);

  // Mount/remount terminal UIs into panel divs whenever visibility changes
  useEffect(() => {
    if (hidden) return;

    const theme = getShellTerminalTheme(settings.baseHue, settings.darkness, settings.textLightness);

    for (const shell of shells) {
      const panelDiv = panelRefs.current.get(shell.id);
      if (!panelDiv) continue;

      // Check if terminal is already mounted in this panel
      let entry = terminalsRef.current.get(shell.id);
      const alreadyMounted = entry && panelDiv.querySelector('.xterm');

      if (alreadyMounted && entry) {
        // Just refit
        requestAnimationFrame(() => {
          entry!.fitAddon.fit();
          debouncedPtyResize(shell.id, entry!.terminal.cols, entry!.terminal.rows);
        });
        continue;
      }

      // Dispose old terminal if exists but not mounted here
      if (entry) {
        entry.terminal.dispose();
        terminalsRef.current.delete(shell.id);
      }

      // Clear panel content
      panelDiv.querySelectorAll('.shell-instance').forEach((el) => el.remove());

      // Create fresh terminal
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: settings.shellFontSize,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontWeight: settings.shellFontWeight as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
        fontWeightBold: settings.shellFontWeightBold as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
        theme,
        allowProposedApi: true,
        macOptionIsMeta: false,
        macOptionClickForcesSelection: false,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      // URL click handler — same routing as the agent terminal. When the
      // Web tab feature is enabled, the click dispatches a window event
      // that App.tsx picks up to focus the in-app browser and navigate;
      // otherwise we fall back to shell.openExternal via window.api.
      terminal.loadAddon(
        new WebLinksAddon((_event, uri) => {
          if (webEnabledRef.current) {
            window.dispatchEvent(new CustomEvent('open-url-in-browser', { detail: { url: uri } }));
          } else {
            window.api.openUrl(uri);
          }
        }),
      );

      const termEl = document.createElement('div');
      termEl.className = 'shell-instance';
      panelDiv.appendChild(termEl);
      terminal.open(termEl);
      // Smart key handler — Option+arrows for word nav, Cmd+C/V for copy/paste
      terminal.attachCustomKeyEventHandler(
        makeTerminalKeyHandler(terminal, (data) => window.api.sendInput(shell.id, data)),
      );

      // Native file drop handler (like VS Code)
      setupTerminalDrop(termEl, (data) => {
        window.api.sendInput(shell.id, data);
      });

      let webglAddon: WebglAddon | undefined;
      if (settings.gpuAcceleration === 'auto') {
        try {
          webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon?.dispose();
            const e = terminalsRef.current.get(shell.id);
            if (e) e.webglAddon = undefined;
          });
          terminal.loadAddon(webglAddon);
        } catch { /* canvas fallback */ }
      }

      // Suppresses xterm.js responses (CPR, OSC color queries, device attrs, etc.)
      // from being routed to the PTY while the saved scrollback is being replayed.
      // Otherwise the answers land on the new shell's prompt as garbage input.
      let replayingScrollback = false;
      terminal.onData((data) => {
        if (replayingScrollback) return;
        window.api.sendInput(shell.id, data);
      });

      terminalsRef.current.set(shell.id, { terminal, fitAddon, webglAddon });

      // Create PTY if not yet created
      if (!shell.ptyCreated) {
        shell.ptyCreated = true;
        requestAnimationFrame(() => {
          fitAddon.fit();
          terminal.focus();
          // Restore scrollback then start shell
          window.api.loadScrollback(shell.id).then((scrollback) => {
            const startPty = () => {
              replayingScrollback = false;
              window.api.createShellTerminal(shell.id, workingDirectory).then(() => {
                window.api.resizeTerminal(shell.id, terminal.cols, terminal.rows);
              });
            };
            if (scrollback && scrollback.trim()) {
              replayingScrollback = true;
              terminal.write('\x1B[90m--- Previous session ---\x1B[0m\r\n');
              terminal.write(scrollback);
              // The write callback fires after xterm.js has fully parsed the data
              // and emitted any synchronous responses. Safe to start the PTY now.
              terminal.write('\r\n', startPty);
            } else {
              startPty();
            }
          });
        });
      } else {
        // PTY already running — just fit
        requestAnimationFrame(() => {
          fitAddon.fit();
          terminal.focus();
          debouncedPtyResize(shell.id, terminal.cols, terminal.rows);
        });
      }
    }
  }, [shells, hidden, settings.baseHue, settings.darkness, settings.shellFontSize, workingDirectory]);

  // Route terminal data
  useEffect(() => {
    const unsub = window.api.onTerminalData(({ profileId: pid, data }) => {
      const entry = terminalsRef.current.get(pid);
      if (entry) {
        const len = data.length;
        entry.terminal.write(data, () => {
          window.api.ackTerminalData(pid, len);
        });
      }
    });
    return () => unsub();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      terminalsRef.current.forEach((e) => e.terminal.dispose());
      terminalsRef.current.clear();
    };
  }, []);

  const createShell = useCallback(() => {
    if (hidden) return;
    const id = `shell:${profileId}:${shellCounter++}`;
    setShells((prev) => {
      const next = [...prev, { id, ptyCreated: false }];
      const each = 100 / next.length;
      setWidths(next.map(() => each));
      return next;
    });
  }, [profileId, hidden]);

  // Create initial shells based on memory
  useEffect(() => {
    if (!hidden && shells.length === 0) {
      const count = Math.max(1, initialShellCount);
      for (let i = 0; i < count; i++) {
        createShell();
      }
    }
  }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  // Observe container resize
  useEffect(() => {
    const panels = document.querySelectorAll(`[data-shell-profile="${profileId}"] .shell-panel`);
    if (panels.length === 0) return;

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (hidden) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        terminalsRef.current.forEach((entry, id) => {
          const panelDiv = panelRefs.current.get(id);
          if (panelDiv && panelDiv.clientHeight > 10 && panelDiv.clientWidth > 10) {
            entry.fitAddon.fit();
            debouncedPtyResize(id, entry.terminal.cols, entry.terminal.rows);
          }
        });
      });
    });

    panels.forEach((p) => observer.observe(p));
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [shells, hidden, profileId]);

  // Focus the shell terminal at focusedIndex when pane receives focus
  useEffect(() => {
    if (focused && shells.length > 0) {
      const idx = Math.min(focusedIndex, shells.length - 1);
      const target = terminalsRef.current.get(shells[idx].id);
      if (target) target.terminal.focus();
    }
  }, [focused, focusedIndex, shells]);

  // Report shell count changes to parent
  useEffect(() => {
    onShellCountChange?.(shells.length);
  }, [shells.length, onShellCountChange]);

  const handleClose = useCallback((shellId: string) => {
    window.api.sendInput(shellId, 'exit\r');
  }, []);

  // Ctrl+Cmd+Plus to split, Ctrl+Cmd+Minus to close focused shell
  useEffect(() => {
    if (hidden) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.metaKey) return;

      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        createShell();
      } else if (e.key === '-') {
        e.preventDefault();
        if (shells.length > 0) {
          handleClose(shells[shells.length - 1].id);
        }
      }
    };

    // Capture phase: when an xterm shell has focus it can consume the
    // keydown before a bubble-phase window listener runs, so the split/close
    // shortcut would silently do nothing. Capturing intercepts it first.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [hidden, shells, createShell, handleClose]);

  // Apply settings to existing terminals
  useEffect(() => {
    const theme = getShellTerminalTheme(settings.baseHue, settings.darkness, settings.textLightness);
    terminalsRef.current.forEach((entry) => {
      entry.terminal.options.fontSize = settings.shellFontSize;
      entry.terminal.options.fontWeight = settings.shellFontWeight as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
      entry.terminal.options.fontWeightBold = settings.shellFontWeightBold as 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
      entry.terminal.options.theme = theme;
      if (!hidden) entry.fitAddon.fit();
    });
  }, [settings.baseHue, settings.darkness, settings.shellFontSize, settings.shellFontWeight, settings.shellFontWeightBold, hidden]);

  const handleResize = useCallback((index: number, delta: number) => {
    const container = document.querySelector(`[data-shell-profile="${profileId}"]`);
    if (!container) return;
    const totalWidth = (container as HTMLElement).clientWidth;
    if (totalWidth === 0) return;
    const deltaPercent = (delta / totalWidth) * 100;

    setWidths((prev) => {
      const next = [...prev];
      const newLeft = next[index] + deltaPercent;
      const newRight = next[index + 1] - deltaPercent;
      if (newLeft >= 10 && newRight >= 10) {
        next[index] = newLeft;
        next[index + 1] = newRight;
      }
      return next;
    });
  }, [profileId]);

  return (
    <div className="shell-pane-container" data-shell-profile={profileId}>
      <div className="shell-panels">
        {shells.map((shell, idx) => (
          <div
            key={shell.id}
            style={{ width: `${widths[idx] || 100}%` }}
            className="shell-panel"
            ref={(el) => { panelRefs.current.set(shell.id, el); }}
          >
            {idx > 0 && (
              <ResizeHandle
                direction="horizontal"
                onResize={(delta) => handleResize(idx - 1, delta)}
              />
            )}
            <button
              className="shell-close-btn"
              onClick={() => handleClose(shell.id)}
              title="Close terminal"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
            {navActive && navFocusedPane.pane === 'shell' && navFocusedPane.shellIndex === idx && (
              <>
                {(idx > 0 || navFocusedPane.pane === 'shell') && (
                  <div className="nav-pane-hint left">
                    <span className="nav-arrow">&#x2190;</span>
                  </div>
                )}
                {idx < shells.length - 1 && (
                  <div className="nav-pane-hint right">
                    <span className="nav-arrow">&#x2192;</span>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <button className="shell-split-btn" onClick={createShell} title="Split terminal (Ctrl+Cmd+=)">
        {splitHintVisible && <span className="shell-hotkey-badge">^⌘+</span>}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M7 0v14M0 7h14" />
        </svg>
      </button>
      {splitHintVisible && shells.length > 0 && (
        <div className="shell-close-hotkey">
          <span className="shell-hotkey-badge">^⌘−</span>
        </div>
      )}
    </div>
  );
}
