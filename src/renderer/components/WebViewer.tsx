import { useEffect, useRef, useState } from 'react';

/** Electron's <webview> tag doesn't have React types; we just declare the
 * subset we touch so TS stops complaining. */
type WebviewLike = HTMLElement & {
  src: string;
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
};

interface Props {
  /** Stable key (`profileId` or `profileId|parallelId`) so each view
   * remembers its own URL across tab switches. */
  instanceKey: string;
  /** Hidden via display:none rather than unmounted so the page state +
   * back/forward history survive tab switches. */
  hidden: boolean;
  /** External navigation request — e.g. a link clicked in the agent
   * terminal. The `nonce` differentiates duplicate URLs so re-clicking
   * the same link still navigates. Ignored when null. */
  pendingNavigate?: { url: string; nonce: number } | null;
}

const DEFAULT_URL = 'https://duckduckgo.com/';

// Per-instance URL cache (module-level so it survives a parent-driven
// remount; keyed by instanceKey). Saves user typing and keeps each
// profile/parallel-agent on its own page.
const lastUrlCache = new Map<string, string>();

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

export function WebViewer({ instanceKey, hidden, pendingNavigate }: Props) {
  const initialUrl = lastUrlCache.get(instanceKey) ?? DEFAULT_URL;
  const [address, setAddress] = useState(initialUrl);
  const [committedUrl, setCommittedUrl] = useState(initialUrl);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const webviewRef = useRef<WebviewLike | null>(null);

  // Cache the latest committed URL per instance for restore on remount.
  useEffect(() => {
    lastUrlCache.set(instanceKey, committedUrl);
  }, [instanceKey, committedUrl]);

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
    el.addEventListener('did-navigate', sync as EventListener);
    el.addEventListener('did-navigate-in-page', sync as EventListener);
    el.addEventListener('did-finish-load', sync as EventListener);
    return () => {
      el.removeEventListener('did-navigate', sync as EventListener);
      el.removeEventListener('did-navigate-in-page', sync as EventListener);
      el.removeEventListener('did-finish-load', sync as EventListener);
    };
  }, []);

  const submit = () => {
    const target = normalizeUrl(address);
    setAddress(target);
    if (webviewRef.current) webviewRef.current.src = target;
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
          onClick={() => webviewRef.current?.reload()}
          title="Reload"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
            <polyline points="13 3 13 6 10 6" />
            <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
            <polyline points="3 13 3 10 6 10" />
          </svg>
        </button>
        <input
          className="web-viewer-address"
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          spellCheck={false}
          placeholder="Search or enter a URL"
        />
      </div>
      <webview
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref={webviewRef as unknown as React.Ref<any>}
        src={committedUrl}
        className="web-viewer-frame"
        // `allowpopups` lets Cmd-click and target=_blank open within the
        // webview instead of being silently swallowed.
        // @ts-expect-error - webview attribute typing in React
        allowpopups="true"
      />
    </div>
  );
}
