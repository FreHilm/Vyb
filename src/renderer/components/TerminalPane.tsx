import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { Profile, AppSettings } from '../../shared/types';
import { getTerminalTheme } from '../theme';

interface TerminalPaneProps {
  profiles: Profile[];
  activeProfileId: string | null;
  initialized: Set<string>;
  shellOpen: boolean;
  onShellExited: () => void;
  settings: AppSettings;
}

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  opened: boolean;
  ptyCreated: boolean;
  kind: 'agent' | 'shell';
}

function shellId(profileId: string): string {
  return `shell:${profileId}`;
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
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new ClipboardAddon());

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

  return { terminal, fitAddon, element, opened: false, ptyCreated: false, kind };
}

function openTerminal(instance: TerminalInstance): void {
  if (instance.opened) return;
  instance.opened = true;
  instance.element.style.display = 'block';
  instance.terminal.open(instance.element);
  try {
    instance.terminal.loadAddon(new WebglAddon());
  } catch {
    // canvas fallback
  }
}

export function TerminalPane({
  profiles,
  activeProfileId,
  initialized,
  shellOpen,
  onShellExited,
  settings,
}: TerminalPaneProps) {
  const agentContainerRef = useRef<HTMLDivElement>(null);
  const shellContainerRef = useRef<HTMLDivElement>(null);
  const agentTerminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const shellTerminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const shellInitializedRef = useRef<Set<string>>(new Set());
  const dataUnsubRef = useRef<(() => void) | null>(null);

  // Route incoming data to the right terminal
  useEffect(() => {
    dataUnsubRef.current = window.api.onTerminalData(({ profileId, data }) => {
      const agentInst = agentTerminalsRef.current.get(profileId);
      if (agentInst) {
        agentInst.terminal.write(data);
        return;
      }
      const shellInst = shellTerminalsRef.current.get(profileId);
      if (shellInst) {
        shellInst.terminal.write(data);
      }
    });

    return () => {
      dataUnsubRef.current?.();
      agentTerminalsRef.current.forEach((inst) => inst.terminal.dispose());
      agentTerminalsRef.current.clear();
      shellTerminalsRef.current.forEach((inst) => inst.terminal.dispose());
      shellTerminalsRef.current.clear();
    };
  }, []);

  // Listen for shell terminal exits
  useEffect(() => {
    const unsub = window.api.onShellExited(({ terminalId }) => {
      const instance = shellTerminalsRef.current.get(terminalId);
      if (instance) {
        instance.terminal.dispose();
        instance.element.remove();
        shellTerminalsRef.current.delete(terminalId);
      }
      shellInitializedRef.current.delete(terminalId);
      onShellExited();
    });

    return () => unsub();
  }, [onShellExited]);

  // Apply settings changes (font size + theme) to all existing terminals
  useEffect(() => {
    const theme = getTerminalTheme(settings.baseHue, settings.darkness);

    const updateTerminal = (instance: TerminalInstance) => {
      const fontSize =
        instance.kind === 'agent' ? settings.agentFontSize : settings.shellFontSize;
      instance.terminal.options.fontSize = fontSize;
      instance.terminal.options.theme = theme;
      if (instance.opened) {
        instance.fitAddon.fit();
      }
    };

    agentTerminalsRef.current.forEach(updateTerminal);
    shellTerminalsRef.current.forEach(updateTerminal);
  }, [settings.baseHue, settings.darkness, settings.agentFontSize, settings.shellFontSize]);

  // Create xterm.js instances for initialized profiles
  useEffect(() => {
    const theme = getTerminalTheme(settings.baseHue, settings.darkness);

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

  // Show/hide agent terminals and lazily create PTY on first show
  useEffect(() => {
    agentTerminalsRef.current.forEach((instance, id) => {
      if (id === activeProfileId) {
        openTerminal(instance);
        instance.element.style.display = 'block';

        requestAnimationFrame(() => {
          instance.fitAddon.fit();
          instance.terminal.focus();

          if (!instance.ptyCreated) {
            instance.ptyCreated = true;
            const profile = profiles.find((p) => p.id === id);
            if (profile) {
              window.api.createTerminal(id, profile).then(() => {
                window.api.resizeTerminal(
                  id,
                  instance.terminal.cols,
                  instance.terminal.rows,
                );
              });
            }
          } else {
            window.api.resizeTerminal(
              id,
              instance.terminal.cols,
              instance.terminal.rows,
            );
          }
        });
      } else {
        instance.element.style.display = 'none';
      }
    });

    shellTerminalsRef.current.forEach((instance, id) => {
      const ownerProfileId = id.replace('shell:', '');
      if (ownerProfileId === activeProfileId && shellOpen) {
        openTerminal(instance);
        instance.element.style.display = 'block';
        requestAnimationFrame(() => {
          instance.fitAddon.fit();
          window.api.resizeTerminal(
            id,
            instance.terminal.cols,
            instance.terminal.rows,
          );
        });
      } else {
        instance.element.style.display = 'none';
      }
    });
  }, [activeProfileId, initialized, shellOpen, profiles]);

  // Create shell terminal when toggled
  const ensureShellTerminal = useCallback(
    (profileId: string) => {
      const sid = shellId(profileId);
      if (shellTerminalsRef.current.has(sid)) return;
      if (!shellContainerRef.current) return;
      if (shellInitializedRef.current.has(sid)) return;

      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return;

      shellInitializedRef.current.add(sid);

      const theme = getTerminalTheme(settings.baseHue, settings.darkness);
      const instance = createTerminalInstance(
        shellContainerRef.current,
        (data) => window.api.sendInput(sid, data),
        settings.shellFontSize,
        theme,
        'shell',
      );

      shellTerminalsRef.current.set(sid, instance);

      openTerminal(instance);
      instance.element.style.display = 'block';

      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        instance.terminal.focus();
        window.api
          .createShellTerminal(sid, profile.workingDirectory)
          .then(() => {
            window.api.resizeTerminal(
              sid,
              instance.terminal.cols,
              instance.terminal.rows,
            );
          });
      });
    },
    [profiles, settings.shellFontSize, settings.baseHue],
  );

  useEffect(() => {
    if (shellOpen && activeProfileId) {
      ensureShellTerminal(activeProfileId);
    }
  }, [shellOpen, activeProfileId, ensureShellTerminal]);

  // Refit visible terminals on container resize
  useEffect(() => {
    const agentContainer = agentContainerRef.current;
    const shellContainer = shellContainerRef.current;
    if (!agentContainer) return;

    const refit = () => {
      if (activeProfileId) {
        const agentInst = agentTerminalsRef.current.get(activeProfileId);
        if (
          agentInst &&
          agentInst.opened &&
          agentInst.element.style.display !== 'none'
        ) {
          agentInst.fitAddon.fit();
          window.api.resizeTerminal(
            activeProfileId,
            agentInst.terminal.cols,
            agentInst.terminal.rows,
          );
        }

        if (shellOpen) {
          const sid = shellId(activeProfileId);
          const shellInst = shellTerminalsRef.current.get(sid);
          if (
            shellInst &&
            shellInst.opened &&
            shellInst.element.style.display !== 'none'
          ) {
            shellInst.fitAddon.fit();
            window.api.resizeTerminal(
              sid,
              shellInst.terminal.cols,
              shellInst.terminal.rows,
            );
          }
        }
      }
    };

    const observer = new ResizeObserver(refit);
    observer.observe(agentContainer);
    if (shellContainer) observer.observe(shellContainer);

    requestAnimationFrame(refit);

    return () => observer.disconnect();
  }, [activeProfileId, shellOpen]);

  return (
    <div className={`terminal-split ${shellOpen ? 'shell-visible' : ''}`}>
      <div className="terminal-pane agent-pane" ref={agentContainerRef}>
        {!activeProfileId && (
          <div className="terminal-placeholder">Select a profile to start</div>
        )}
      </div>
      <div
        className="terminal-divider"
        style={{ display: shellOpen ? 'block' : 'none' }}
      />
      <div
        className="terminal-pane shell-pane"
        ref={shellContainerRef}
        style={{ display: shellOpen ? 'block' : 'none' }}
      />
    </div>
  );
}
