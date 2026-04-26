import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { Profile, AppSettings } from '../../shared/types';
import { getTerminalTheme } from '../theme';
import { setupTerminalDrop, debouncedPtyResize, makeTerminalKeyHandler } from './TerminalPane';

interface KanbanViewerProps {
  profile: Profile;
  settings: AppSettings;
}

export function KanbanViewer({ profile, settings }: KanbanViewerProps) {
  const mode = settings.ordnaMode || 'web';
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [tuiPtyId, setTuiPtyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Start (or restart) Ordna whenever the profile or mode changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWebUrl(null);
    setTuiPtyId(null);

    window.api.startOrdna(profile.id, mode).then((res) => {
      if (cancelled) return;
      if (res.error) {
        setError(res.error);
        setLoading(false);
        return;
      }
      if (res.webUrl) setWebUrl(res.webUrl);
      if (res.tuiPtyId) setTuiPtyId(res.tuiPtyId);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      window.api.stopOrdna().catch((): void => undefined);
    };
  }, [profile.id, mode]);

  if (loading) {
    return (
      <div className="kanban-viewer">
        <div className="kanban-loading">Starting Ordna…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="kanban-viewer">
        <div className="kanban-error">
          <p>Failed to start Ordna: {error}</p>
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Make sure the project working directory is initialized with{' '}
            <code>ordna init</code>.
          </p>
        </div>
      </div>
    );
  }

  if (mode === 'web' && webUrl) {
    return (
      <div className="kanban-viewer">
        <iframe
          src={webUrl}
          className="kanban-iframe"
          title="Ordna Kanban"
        />
      </div>
    );
  }

  if (mode === 'tui' && tuiPtyId) {
    return <KanbanTui ptyId={tuiPtyId} settings={settings} />;
  }

  return (
    <div className="kanban-viewer">
      <div className="kanban-error">Ordna is not running.</div>
    </div>
  );
}

function KanbanTui({ ptyId, settings }: { ptyId: string; settings: AppSettings }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon; webglAddon?: WebglAddon } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const theme = getTerminalTheme(settings.baseHue, settings.darkness);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: settings.shellFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme,
      allowProposedApi: true,
      macOptionIsMeta: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const termEl = document.createElement('div');
    termEl.className = 'kanban-tui-instance';
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
  }, [ptyId, settings.baseHue, settings.darkness, settings.shellFontSize, settings.gpuAcceleration]);

  return (
    <div className="kanban-viewer">
      <div ref={containerRef} className="kanban-tui-container" />
    </div>
  );
}
