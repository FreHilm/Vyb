import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { AppSettings, ParallelAgent } from '../../shared/types';
import { getTerminalTheme } from '../theme';
import { setupTerminalDrop, debouncedPtyResize, makeTerminalKeyHandler } from './TerminalPane';

interface Props {
  agent: ParallelAgent;
  settings: AppSettings;
  hidden: boolean;
}

/** Renders the xterm.js view for a single parallel-agent PTY (`parallel:<id>`).
 * Stays mounted while the agent is alive so switching to/from it preserves
 * scrollback and selection. */
export function ParallelAgentTerminal({ agent, settings, hidden }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon; webglAddon?: WebglAddon } | null>(null);
  const ptyId = `parallel:${agent.id}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const theme = getTerminalTheme(settings.baseHue, settings.darkness, settings.textLightness);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: settings.agentFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme,
      allowProposedApi: true,
      macOptionIsMeta: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const termEl = document.createElement('div');
    termEl.className = 'parallel-agent-terminal-instance';
    container.appendChild(termEl);
    terminal.open(termEl);
    terminal.attachCustomKeyEventHandler(
      makeTerminalKeyHandler(terminal, (data) => window.api.sendInput(ptyId, data)),
    );
    setupTerminalDrop(termEl, (data) => window.api.sendInput(ptyId, data));

    let webglAddon: WebglAddon | undefined;
    if (settings.gpuAcceleration === 'auto') {
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          if (termRef.current) termRef.current.webglAddon = undefined;
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // canvas fallback
      }
    }

    terminal.onData((data) => window.api.sendInput(ptyId, data));

    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
      window.api.resizeTerminal(ptyId, terminal.cols, terminal.rows);
    });

    termRef.current = { terminal, fitAddon, webglAddon };

    const unsub = window.api.onTerminalData(({ profileId, data }) => {
      if (profileId !== ptyId) return;
      terminal.write(data);
      window.api.ackTerminalData(ptyId, data.length);
    });

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (container.clientHeight > 10 && container.clientWidth > 10) {
          fitAddon.fit();
          debouncedPtyResize(ptyId, terminal.cols, terminal.rows);
        }
      });
    });
    observer.observe(container);

    return () => {
      unsub();
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      if (webglAddon) webglAddon.dispose();
      terminal.dispose();
      termRef.current = null;
    };
  }, [ptyId, settings.baseHue, settings.darkness, settings.agentFontSize, settings.gpuAcceleration]);

  // Refit + focus when the pane is unhidden
  useEffect(() => {
    if (hidden) return;
    const t = termRef.current;
    if (!t) return;
    const id = requestAnimationFrame(() => {
      if (containerRef.current && containerRef.current.clientHeight > 10) {
        t.fitAddon.fit();
        t.terminal.focus();
        debouncedPtyResize(ptyId, t.terminal.cols, t.terminal.rows);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [hidden, ptyId]);

  return (
    <div
      className="parallel-agent-terminal"
      style={hidden ? { display: 'none' } : { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}
    >
      <div ref={containerRef} className="parallel-agent-terminal-container" />
    </div>
  );
}
