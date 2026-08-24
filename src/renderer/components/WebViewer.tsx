import { useCallback, useEffect, useRef, useState } from 'react';

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
  /** Fired when the ACTIVE tab commits to a new URL. The parent persists
   * this so the same URL is restored next launch. */
  onUrlChange?: (key: string, url: string) => void;
}

const DEFAULT_URL = 'https://duckduckgo.com/';

/** Build the webview's `persist:` partition name from the instanceKey.
 * Each unique partition gets its own on-disk session under
 * userData/Partitions/, so cookies / localStorage / login state are
 * preserved between app restarts and isolated per profile/parallel.
 * All TABS of one instance share the partition — like browser tabs
 * sharing one session. */
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

function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** One browser tab. The <webview> element itself is kept alive (hidden
 * via display:none when inactive) so each tab's page state and history
 * survive switching — `initialSrc` is set once at creation and never
 * re-rendered; all later navigation is imperative via the element. */
interface WebTab {
  id: number;
  initialSrc: string;
  committedUrl: string;
  title: string;
  canBack: boolean;
  canForward: boolean;
  loading: boolean;
  devtoolsOpen: boolean;
}

function makeTab(id: number, url: string): WebTab {
  return {
    id,
    initialSrc: url,
    committedUrl: url,
    title: '',
    canBack: false,
    canForward: false,
    loading: false,
    devtoolsOpen: false,
  };
}

export function WebViewer({ instanceKey, initialUrl, hidden, pendingNavigate, onUrlChange }: Props) {
  const startUrl = initialUrl && initialUrl.length > 0 ? initialUrl : DEFAULT_URL;
  // If a navigation is already queued when we first mount — the common case
  // where clicking a link BOTH opens the Web tab and requests the URL — load
  // that target directly as the first tab's src. Initialising to `startUrl`
  // and swapping src a beat later is unreliable: on a brand-new webview the
  // guest page hasn't attached yet, so the early src change is dropped.
  const mountUrl = pendingNavigate ? normalizeUrl(pendingNavigate.url) : startUrl;

  const nextTabIdRef = useRef(2);
  const [tabs, setTabs] = useState<WebTab[]>([makeTab(1, mountUrl)]);
  const [activeId, setActiveId] = useState(1);
  const [address, setAddress] = useState(mountUrl);

  const webviewRefs = useRef(new Map<number, WebviewLike>());
  const wiredRef = useRef(new Set<number>());
  /** tabId → webContentsId (valid after that tab's dom-ready). */
  const contentsIdsRef = useRef(new Map<number, number>());
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const addressInputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeWebview = () => webviewRefs.current.get(activeIdRef.current) ?? null;

  const updateTab = useCallback((tabId: number, patch: Partial<WebTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...patch } : t)));
  }, []);

  const openTab = useCallback((url: string, activate = true) => {
    const id = nextTabIdRef.current++;
    setTabs((prev) => [...prev, makeTab(id, normalizeUrl(url))]);
    if (activate) {
      setActiveId(id);
      setAddress(normalizeUrl(url));
    }
    return id;
  }, []);

  const closeTab = useCallback((tabId: number) => {
    const contentsId = contentsIdsRef.current.get(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.devtoolsOpen && contentsId != null) {
      window.api.closeWebviewDevTools(contentsId).catch((): void => undefined);
    }
    contentsIdsRef.current.delete(tabId);
    webviewRefs.current.delete(tabId);
    wiredRef.current.delete(tabId);
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        // Closing the last tab resets the browser to a fresh default tab
        // (the Web view itself is closed via the command bar, not here).
        const fresh = makeTab(nextTabIdRef.current++, DEFAULT_URL);
        setActiveId(fresh.id);
        setAddress(fresh.committedUrl);
        return [fresh];
      }
      if (tabId === activeIdRef.current) {
        const neighbor = next[Math.min(Math.max(0, idx), next.length - 1)];
        setActiveId(neighbor.id);
        setAddress(neighbor.committedUrl);
      }
      return next;
    });
  }, [tabs]);

  // Address bar follows the active tab.
  const selectTab = useCallback((tabId: number) => {
    setActiveId(tabId);
    const t = tabs.find((x) => x.id === tabId);
    if (t) setAddress(t.committedUrl);
  }, [tabs]);

  // Wire a tab's <webview> events the moment its element mounts. The
  // element lives until the tab closes, so listeners are attached once
  // and go away with the element — no explicit teardown needed.
  const attachWebview = useCallback((tabId: number) => (node: unknown) => {
    const el = node as WebviewLike | null;
    if (!el) {
      webviewRefs.current.delete(tabId);
      wiredRef.current.delete(tabId);
      return;
    }
    webviewRefs.current.set(tabId, el);
    if (wiredRef.current.has(tabId)) return;
    wiredRef.current.add(tabId);

    const sync = () => {
      try {
        const url = el.getURL();
        const patch: Partial<WebTab> = {
          canBack: el.canGoBack(),
          canForward: el.canGoForward(),
        };
        if (url && url !== 'about:blank') {
          patch.committedUrl = url;
          if (tabId === activeIdRef.current) setAddress(url);
        }
        updateTab(tabId, patch);
      } catch {
        // webview not fully initialised yet
      }
    };
    el.addEventListener('did-start-loading', () => updateTab(tabId, { loading: true }));
    el.addEventListener('did-stop-loading', () => updateTab(tabId, { loading: false }));
    el.addEventListener('did-navigate', sync);
    el.addEventListener('did-navigate-in-page', sync);
    el.addEventListener('did-finish-load', sync);
    el.addEventListener('page-title-updated', ((e: Event) => {
      const title = (e as Event & { title?: string }).title;
      if (title) updateTab(tabId, { title });
    }) as EventListener);
    // Register the main process's context-menu listener for this webview
    // once its WebContents exists. Main dedups, so navigations that fire
    // dom-ready again won't stack duplicate menus.
    el.addEventListener('dom-ready', () => {
      try {
        const id = el.getWebContentsId();
        contentsIdsRef.current.set(tabId, id);
        window.api.registerWebviewContextMenu(id);
      } catch { /* webview not ready yet */ }
    });
  }, [updateTab]);

  // Bubble the ACTIVE tab's URL up so App.tsx can persist it to
  // settings.webUrls. Skip when it still matches the initial URL.
  useEffect(() => {
    if (!onUrlChange || !activeTab) return;
    if (activeTab.committedUrl === startUrl) return;
    onUrlChange(instanceKey, activeTab.committedUrl);
  }, [instanceKey, activeTab?.committedUrl, startUrl, onUrlChange]);

  // The nonce we already satisfied via `mountUrl` at construction.
  const handledNonceRef = useRef<number | null>(pendingNavigate?.nonce ?? null);

  // External navigation request — drive the ACTIVE tab to the URL.
  useEffect(() => {
    if (!pendingNavigate) return;
    if (pendingNavigate.nonce === handledNonceRef.current) return;
    handledNonceRef.current = pendingNavigate.nonce;
    const target = normalizeUrl(pendingNavigate.url);
    setAddress(target);
    updateTab(activeIdRef.current, { committedUrl: target });
    const el = activeWebview();
    if (el) el.src = target;
  }, [pendingNavigate?.nonce]);

  // target=_blank / window.open from a page in ANY of this instance's
  // tabs → open as a new tab here (main denies the popup window and
  // forwards the URL with the source WebContents id).
  useEffect(() => {
    const off = window.api.onWebviewOpenTab(({ sourceId, url }) => {
      for (const id of contentsIdsRef.current.values()) {
        if (id === sourceId) {
          openTab(url, true);
          return;
        }
      }
    });
    return off;
  }, [openTab]);

  // Inbound "Inspect Element" requests from the main-process context
  // menu — match against any of this instance's tabs.
  useEffect(() => {
    const off = window.api.onWebviewInspectRequest(async ({ targetId, x, y }) => {
      for (const [tabId, id] of contentsIdsRef.current.entries()) {
        if (id !== targetId) continue;
        await window.api.openWebviewDevTools(targetId, 0);
        updateTab(tabId, { devtoolsOpen: true });
        window.api.webviewInspectAt(targetId, x, y);
        return;
      }
    });
    return off;
  }, [updateTab]);

  const submit = () => {
    const target = normalizeUrl(address);
    setAddress(target);
    updateTab(activeIdRef.current, { committedUrl: target });
    const el = activeWebview();
    if (el) el.src = target;
  };

  const toggleDevTools = async () => {
    const tab = activeTab;
    if (!tab) return;
    const id = contentsIdsRef.current.get(tab.id);
    if (id == null) return;
    if (tab.devtoolsOpen) {
      try { await window.api.closeWebviewDevTools(id); } catch { /* ignore */ }
      updateTab(tab.id, { devtoolsOpen: false });
    } else {
      try { await window.api.openWebviewDevTools(id, 0); } catch { /* ignore */ }
      updateTab(tab.id, { devtoolsOpen: true });
    }
  };

  return (
    <div
      className="web-viewer"
      style={hidden ? { display: 'none' } : { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      <div className="web-viewer-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`web-viewer-tab${tab.id === activeId ? ' is-active' : ''}`}
            onClick={() => selectTab(tab.id)}
            onAuxClick={(e) => { if (e.button === 1) closeTab(tab.id); }}
            title={tab.committedUrl}
          >
            {tab.loading ? (
              <svg className="spinner-svg" width="10" height="10" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} opacity={0.7}>
                <circle cx="8" cy="8" r="6" />
                <path d="M2 8h12M8 2c1.8 1.8 2.7 4 2.7 6S9.8 12.2 8 14c-1.8-1.8-2.7-4-2.7-6S6.2 3.8 8 2z" />
              </svg>
            )}
            <span className="web-viewer-tab-label">
              {tab.title || hostLabel(tab.committedUrl)}
            </span>
            <button
              className="web-viewer-tab-close"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="web-viewer-tab-add"
          onClick={() => {
            openTab(DEFAULT_URL, true);
            // Ready to type a URL straight away.
            requestAnimationFrame(() => {
              addressInputRef.current?.focus();
              addressInputRef.current?.select();
            });
          }}
          title="New tab"
        >
          +
        </button>
      </div>
      <div className="web-viewer-bar">
        <button
          className="web-viewer-btn"
          disabled={!activeTab?.canBack}
          onClick={() => activeWebview()?.goBack()}
          title="Back"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 3 5 8 10 13" />
          </svg>
        </button>
        <button
          className="web-viewer-btn"
          disabled={!activeTab?.canForward}
          onClick={() => activeWebview()?.goForward()}
          title="Forward"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 3 11 8 6 13" />
          </svg>
        </button>
        <button
          className="web-viewer-btn"
          onClick={() => activeTab?.loading ? activeWebview()?.stop() : activeWebview()?.reload()}
          title={activeTab?.loading ? 'Stop' : 'Reload'}
        >
          {activeTab?.loading ? (
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
          ref={addressInputRef}
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
          className={`web-viewer-btn${activeTab?.devtoolsOpen ? ' is-active' : ''}`}
          onClick={toggleDevTools}
          title={activeTab?.devtoolsOpen ? 'Close DevTools' : 'Open DevTools'}
        >
          {/* Wrench / inspector glyph — close enough to the standard
              DevTools icon without dragging in another icon file. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 4 5 7 2 10" />
            <line x1="7" y1="11" x2="14" y2="11" />
          </svg>
        </button>
      </div>
      {tabs.map((tab) => (
        <webview
          key={tab.id}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={attachWebview(tab.id) as unknown as React.Ref<any>}
          src={tab.initialSrc}
          className="web-viewer-frame"
          style={tab.id === activeId ? undefined : { display: 'none' }}
          partition={webPartition(instanceKey)}
          // @ts-expect-error - webview attribute typing in React
          allowpopups="true"
        />
      ))}
    </div>
  );
}
