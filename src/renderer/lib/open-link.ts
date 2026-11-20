import type { ILinkHandler } from '@xterm/xterm';

/**
 * One route for link clicks from anywhere in the renderer (terminals,
 * rendered markdown, popups the main process intercepts):
 *
 * - http(s) → `open-url-in-browser`, which App.tsx turns into the in-app
 *   Web tab, or the OS browser when the Web function is off.
 * - file:// → `open-file-in-explorer`, so a linked path opens in Files.
 * - anything else is ignored.
 */
export function openLink(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    window.dispatchEvent(new CustomEvent('open-url-in-browser', { detail: { url: url.href } }));
  } else if (url.protocol === 'file:') {
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1); // file:///C:/… on Windows
    window.dispatchEvent(new CustomEvent('open-file-in-explorer', { detail: { path } }));
  }
}

/**
 * xterm handler for OSC 8 hyperlinks (escape-sequence links, which Claude
 * Code and other CLIs print). Without one, xterm shows a confirm() and
 * window.open()s a bare browser window. Non-http protocols are allowed so
 * file:// links reach openLink, which ignores every other scheme.
 */
export const terminalLinkHandler: ILinkHandler = {
  allowNonHttpProtocols: true,
  activate: (_event, uri) => openLink(uri),
};
