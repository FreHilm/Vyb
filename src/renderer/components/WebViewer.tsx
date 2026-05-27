import { useEffect, useRef, useState } from 'react';

/** Electron's <webview> tag doesn't have React types; we just declare the
 * subset we touch so TS stops complaining. */
type WebviewLike = HTMLElement & {
  src: string;
  reload: () => void;
  stop: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  /** Returns the underlying WebContents ID. Only valid after `dom-ready`. */
  getWebContentsId: () => number;
};

interface Props {
  /** Stable key (`profileId` or `profileId|parallelId`) so each view
   * remembers its own URL across tab switches. */
  instanceKey: string;
  /** URL to load on (re)mount. Threaded from App.tsx via `settings.webUrls`
   * so the page survives Vyb restarts. Empty / null falls back to the
   * default landing page. */
  initialUrl?: string;
  /** Hidden via display:none rather than unmounted so the page state +
   * back/forward history survive tab switches. */
  hidden: boolean;
  /** External navigation request — e.g. a link clicked in the agent
   * terminal. The `nonce` differentiates duplicate URLs so re-clicking
   * the same link still navigates. Ignored when null. */
  pendingNavigate?: { url: string; nonce: number } | null;
  /** Fired when the webview commits to a new URL (page navigated). The
   * parent persists this so the same URL is restored next launch. */
  onUrlChange?: (key: string, url: string) => void;
}

const DEFAULT_URL = 'https://duckduckgo.com/';

/** Build the webview's `persist:` partition name from the instanceKey.
 * Each unique partition gets its own on-disk session under
 * userData/Partitions/, so cookies / localStorage / login state are
 * preserved between app restarts and isolated per profile/parallel. */
function webPartition(instanceKey: string): string {
  // Sanitise `|` (used in viewKey for parallel agents) and any other
  // path-unfriendly characters. Electron treats the string after `persist:`
  // as a folder name on disk.
  return `persist:web-${instanceKey.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_URL;
  // Already a URL?
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  // Looks like a host or path → assume https
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed) || trimmed.startsWith('localhost')) {
    return `https://${trimmed}`;
  }
  // Otherwise treat as a search query
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

export function WebViewer({ instanceKey, initialUrl, hidden, pendingNavigate, onUrlChange }: Props) {
  const startUrl = initialUrl && initialUrl.length > 0 ? initialUrl : DEFAULT_URL;
  const [address, setAddress] = useState(startUrl);
  const [committedUrl, setCommittedUrl] = useState(startUrl);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [navLoading, setNavLoading] = useState(false);
  const webviewRef = useRef<WebviewLike | null>(null);
  // Cached main-webview webContentsId. Captured after dom-ready so we
  // can register the context-menu listener and route inbound inspect
  // requests to the correct WebViewer instance.
  const mainContentsIdRef = useRef<number | null>(null);

  // Bubble URL changes up so App.tsx can persist them to settings.webUrls
  // (and from there to disk on the next debounce). We skip the very first
  // value if it matches the initial URL — no point writing back the same
  // value we just read.
  useEffect(() => {
    if (!onUrlChange) return;
    if (committedUrl === startUrl) return;
    onUrlChange(instanceKey, committedUrl);
  }, [instanceKey, committedUrl, startUrl, onUrlChange]);

  // External navigation request — drive the webview to the URL. Keyed on
  // the nonce so re-clicking the same URL still re-navigates.
  useEffect(() => {
    if (!pendingNavigate) return;
    const target = normalizeUrl(pendingNavigate.url);
    setAddress(target);
    setCommittedUrl(target);
    if (webviewRef.current) webviewRef.current.src = target;
  }, [pendingNavigate?.nonce]);

  // Wire <webview> events. The webview tag fires DOM CustomEvents; we
  // bridge them into state so the toolbar reflects the page's state.
  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;
    const sync = () => {
      try {
        const url = el.getURL();
        if (url && url !== 'about:blank') {
          setCommittedUrl(url);
          setAddress(url);
        }
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
      } catch {
        // webview not fully initialised yet
      }
    };
    // Loading indicator — driven by the webview's start/stop events so
    // the user gets feedback between hitting Enter and the page
    // committing (slow sites otherwise look frozen).
    const onStart = () => setNavLoading(true);
    const onStop = () => setNavLoading(false);
    el.addEventListener('did-start-loading', onStart as EventListener);
    el.addEventListener('did-stop-loading', onStop as EventListener);
    el.addEventListener('did-navigate', sync as EventListener);
    el.addEventListener('did-navigate-in-page', sync as EventListener);
    el.addEventListener('did-finish-load', sync as EventListener);
    // Register the main process's context-menu listener for this
    // webview once its WebContents exists. Main dedups, so navigations
    // that fire dom-ready again won't stack duplicate menus.
    const onDomReady = () => {
      try {
        const id = el.getWebContentsId();
        mainContentsIdRef.current = id;
        window.api.registerWebviewContextMenu(id);
      } catch { /* webview not ready yet */ }
    };
    el.addEventListener('dom-ready', onDomReady as EventListener);
    return () => {
      el.removeEventListener('did-start-loading', onStart as EventListener);
      el.removeEventListener('did-stop-loading', onStop as EventListener);
      el.removeEventListener('did-navigate', sync as EventListener);
      el.removeEventListener('did-navigate-in-page', sync as EventListener);
      el.removeEventListener('did-finish-load', sync as EventListener);
      el.removeEventListener('dom-ready', onDomReady as EventListener);
    };
  }, []);

  // Inbound "Inspect Element" requests from the main-process context
  // menu. Each WebViewer filters by targetId so only the matching
  // instance reacts. We ask main to open DevTools (idempotent — it
  // focuses if already open) then call inspectAt to highlight the
  // clicked node in the Elements panel.
  useEffect(() => {
    const off = window.api.onWebviewInspectRequest(async ({ targetId, x, y }) => {
      if (targetId !== mainContentsIdRef.current) return;
      // Open (or focus) DevTools first so inspectElement has somewhere
      // to land — the hostId arg is unused now that DevTools detaches.
      await window.api.openWebviewDevTools(targetId, 0);
      setDevtoolsOpen(true);
      window.api.webviewInspectAt(targetId, x, y);
    });
    return off;
  }, []);

  const submit = () => {
    const target = normalizeUrl(address);
    setAddress(target);
    if (webviewRef.current) webviewRef.current.src = target;
  };

  const toggleDevTools = async () => {
    const id = mainContentsIdRef.current;
    if (id == null) return;
    if (devtoolsOpen) {
      try { await window.api.closeWebviewDevTools(id); } catch { /* ignore */ }
      setDevtoolsOpen(false);
    } else {
      try { await window.api.openWebviewDevTools(id, 0); } catch { /* ignore */ }
      setDevtoolsOpen(true);
    }
  };

  return (
    <div
      className="web-viewer"
      style={hidden ? { display: 'none' } : { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      <div className="web-viewer-bar">
        <button
          className="web-viewer-btn"
          disabled={!canBack}
          onClick={() => webviewRef.current?.goBack()}
          title="Back"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 3 5 8 10 13" />
          </svg>
        </button>
        <button
          className="web-viewer-btn"
          disabled={!canForward}
          onClick={() => webviewRef.current?.goForward()}
          title="Forward"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 3 11 8 6 13" />
          </svg>
        </button>
        <button
          className="web-viewer-btn"
          onClick={() => navLoading ? webviewRef.current?.stop() : webviewRef.current?.reload()}
          title={navLoading ? 'Stop' : 'Reload'}
        >
          {navLoading ? (
            // Spinning loader doubling as a stop button while the page loads.
            <svg className="spinner-svg" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
              <polyline points="13 3 13 6 10 6" />
              <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
              <polyline points="3 13 3 10 6 10" />
            </svg>
          )}
        </button>
        <input
          className="web-viewer-address"
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          /* Browser-style focus behaviour: clicking the bar while it
             isn't already focused selects all text. Subsequent clicks
             (caret placement, drag-to-select) work normally. We do this
             on mousedown so we can preventDefault before the click
             positions the caret. */
          onMouseDown={(e) => {
            const el = e.currentTarget;
            if (document.activeElement !== el) {
              e.preventDefault();
              el.focus();
              el.select();
            }
          }}
          spellCheck={false}
          placeholder="Search or enter a URL"
        />
        <button
          className={`web-viewer-btn${devtoolsOpen ? ' is-active' : ''}`}
          onClick={toggleDevTools}
          title={devtoolsOpen ? 'Close DevTools' : 'Open DevTools'}
        >
          {/* Wrench / inspector glyph — close enough to the standard
              DevTools icon without dragging in another icon file. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 4 5 7 2 10" />
            <line x1="7" y1="11" x2="14" y2="11" />
          </svg>
        </button>
      </div>
      <webview
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref={webviewRef as unknown as React.Ref<any>}
        src={committedUrl}
        className="web-viewer-frame"
        partition={webPartition(instanceKey)}
        // @ts-expect-error - webview attribute typing in React
        allowpopups="true"
      />
    </div>
  );
}
