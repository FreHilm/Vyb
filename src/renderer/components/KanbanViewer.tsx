import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { AppSettings } from '../../shared/types';
import { getTerminalTheme } from '../theme';
import { setupTerminalDrop, debouncedPtyResize, makeTerminalKeyHandler } from './TerminalPane';

interface KanbanViewerProps {
  /** Opaque key for this Ordna instance — `${profileId}` for parent view,
   * `${profileId}|${parallelId}` for a parallel agent's view. */
  instanceKey: string;
  /** Owning profile id, used by the main process for hook routing. */
  profileId: string;
  /** Working directory the Ordna instance should run in. For parallel views
   * this is the agent's worktree path; otherwise the profile's cwd. */
  cwd: string;
  settings: AppSettings;
  /** When true, the view is rendered with display:none so its iframe / xterm
   * stays mounted and the underlying Ordna instance keeps running. */
  hidden: boolean;
}

export function KanbanViewer({ instanceKey, profileId, cwd, settings, hidden }: KanbanViewerProps) {
  const mode = settings.ordnaMode || 'web';
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [tuiPtyId, setTuiPtyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Start the Ordna instance for THIS view once on mount. The Map-backed
  // OrdnaManager makes start() idempotent — re-mounts won't spawn a duplicate.
  // Stop only on real unmount (kanban closed or profile/parallel went away).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWebUrl(null);
    setTuiPtyId(null);

    window.api.startOrdna(instanceKey, profileId, cwd, mode).then((res) => {
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
      window.api.stopOrdna(instanceKey).catch((): void => undefined);
    };
  }, [instanceKey, profileId, cwd, mode]);

  const wrapperStyle: React.CSSProperties = hidden
    ? { display: 'none' }
    : { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 };

  if (loading) {
    return (
      <div className="kanban-viewer" style={wrapperStyle}>
        <div className="kanban-loading">Starting Ordna…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="kanban-viewer" style={wrapperStyle}>
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
      <div className="kanban-viewer" style={wrapperStyle}>
        <iframe
          src={webUrl}
          className="kanban-iframe"
          title="Ordna Kanban"
        />
      </div>
    );
  }

  if (mode === 'tui' && tuiPtyId) {
    return <KanbanTui ptyId={tuiPtyId} settings={settings} hidden={hidden} />;
  }

  return (
    <div className="kanban-viewer" style={wrapperStyle}>
      <div className="kanban-error">Ordna is not running.</div>
    </div>
  );
}

function KanbanTui({ ptyId, settings, hidden }: { ptyId: string; settings: AppSettings; hidden: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon; webglAddon?: WebglAddon } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const theme = getTerminalTheme(settings.baseHue, settings.darkness, settings.textLightness);
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
      const len = data.length;
      terminal.write(data, () => {
        window.api.ackTerminalData(ptyId, len);
      });
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

  // When the pane comes back into view, refit so xterm matches the new container size
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
      className="kanban-viewer"
      style={hidden ? { display: 'none' } : { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}
    >
      <div ref={containerRef} className="kanban-tui-container" />
    </div>
  );
}
