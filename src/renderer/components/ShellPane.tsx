import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { AppSettings } from '../../shared/types';
import { getTerminalTheme } from '../theme';
import { ResizeHandle } from './ResizeHandle';

interface ShellPaneProps {
  profileId: string;
  workingDirectory: string;
  hidden: boolean;
  settings: AppSettings;
  onAllClosed: () => void;
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
}: ShellPaneProps) {
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [widths, setWidths] = useState<number[]>([]);
  const terminalsRef = useRef<Map<string, { terminal: Terminal; fitAddon: FitAddon }>>(new Map());
  const panelRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Listen for shell exits
  useEffect(() => {
    const unsub = window.api.onShellExited(({ terminalId }) => {
      const entry = terminalsRef.current.get(terminalId);
      if (entry) {
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

  // Mount/remount terminal UIs into panel divs whenever visibility changes
  useEffect(() => {
    if (hidden) return;

    const theme = getTerminalTheme(settings.baseHue, settings.darkness);

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
          window.api.resizeTerminal(shell.id, entry!.terminal.cols, entry!.terminal.rows);
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
        theme,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new ClipboardAddon());

      const termEl = document.createElement('div');
      termEl.className = 'shell-instance';
      panelDiv.appendChild(termEl);
      terminal.open(termEl);

      try {
        terminal.loadAddon(new WebglAddon());
      } catch { /* canvas fallback */ }

      terminal.onData((data) => {
        window.api.sendInput(shell.id, data);
      });

      terminalsRef.current.set(shell.id, { terminal, fitAddon });

      // Create PTY if not yet created
      if (!shell.ptyCreated) {
        shell.ptyCreated = true;
        requestAnimationFrame(() => {
          fitAddon.fit();
          terminal.focus();
          window.api.createShellTerminal(shell.id, workingDirectory).then(() => {
            window.api.resizeTerminal(shell.id, terminal.cols, terminal.rows);
          });
        });
      } else {
        // PTY already running — just fit
        requestAnimationFrame(() => {
          fitAddon.fit();
          terminal.focus();
          window.api.resizeTerminal(shell.id, terminal.cols, terminal.rows);
        });
      }
    }
  }, [shells, hidden, settings.baseHue, settings.darkness, settings.shellFontSize, workingDirectory]);

  // Route terminal data
  useEffect(() => {
    const unsub = window.api.onTerminalData(({ profileId: pid, data }) => {
      const entry = terminalsRef.current.get(pid);
      if (entry) entry.terminal.write(data);
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

  // Create first shell
  useEffect(() => {
    if (!hidden && shells.length === 0) {
      createShell();
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
            window.api.resizeTerminal(id, entry.terminal.cols, entry.terminal.rows);
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

  // Apply settings to existing terminals
  useEffect(() => {
    const theme = getTerminalTheme(settings.baseHue, settings.darkness);
    terminalsRef.current.forEach((entry) => {
      entry.terminal.options.fontSize = settings.shellFontSize;
      entry.terminal.options.theme = theme;
      if (!hidden) entry.fitAddon.fit();
    });
  }, [settings.baseHue, settings.darkness, settings.shellFontSize, hidden]);

  const handleClose = useCallback((shellId: string) => {
    window.api.sendInput(shellId, 'exit\r');
  }, []);

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
              <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor">
                <path d="M1.7 0.3a1 1 0 00-1.4 1.4L5.6 7l-5.3 5.3a1 1 0 101.4 1.4L7 8.4l5.3 5.3a1 1 0 001.4-1.4L8.4 7l5.3-5.3a1 1 0 00-1.4-1.4L7 5.6 1.7 0.3z" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <button className="shell-split-btn" onClick={createShell} title="Split terminal">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M7 0v14M0 7h14" />
        </svg>
      </button>
    </div>
  );
}
