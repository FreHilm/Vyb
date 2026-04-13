import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
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

function openTerminal(instance: TerminalInstance, gpuMode: string): void {
  if (instance.opened) return;
  instance.opened = true;
  instance.element.style.display = 'block';
  instance.terminal.open(instance.element);
  activateWebgl(instance, gpuMode);
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
        openTerminal(instance, settings.gpuAcceleration);
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
                window.api.resizeTerminal(id, instance.terminal.cols, instance.terminal.rows);
              });
            }
          } else {
            // Restore terminal state from backend replay buffer
            window.api.serializeTerminal(id).then((serialized) => {
              if (serialized) {
                instance.terminal.reset();
                instance.terminal.write(serialized);
              }
              window.api.resizeTerminal(id, instance.terminal.cols, instance.terminal.rows);
            });
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

  // Refit when returning from hidden
  useEffect(() => {
    if (hidden) return;
    const timer = setTimeout(() => {
      if (activeProfileId) {
        const agentInst = agentTerminalsRef.current.get(activeProfileId);
        if (agentInst && agentInst.opened) {
          agentInst.fitAddon.fit();
          window.api.resizeTerminal(activeProfileId, agentInst.terminal.cols, agentInst.terminal.rows);
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

  // Refit agent terminals on container resize — debounced to avoid zero-dimension fits
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
            window.api.resizeTerminal(activeProfileId, agentInst.terminal.cols, agentInst.terminal.rows);
          }
        }
      });
    };

    const observer = new ResizeObserver(refit);
    observer.observe(agentContainer);
    requestAnimationFrame(refit);
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
      <div className="terminal-pane agent-pane" style={agentStyle} ref={agentContainerRef}>
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
