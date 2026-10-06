import { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';

/**
 * Word-document viewer (.docx) for the FileExplorer — renders Word-like
 * white pages (margins, page breaks) via docx-preview. View-only: the
 * FileExplorer disables Save/Format/Find for these tabs, same as images
 * and PDFs.
 *
 * File bytes arrive over the FILE_READ_BINARY IPC — fetch() on the
 * local-file:// protocol is rejected by Chromium for non-'standard'
 * schemes, and the scheme stays non-standard for the other consumers'
 * sake. Legacy .doc (pre-2007 binary format) and corrupt archives reject
 * inside renderAsync and surface as the error fallback.
 */
export function DocxViewer({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  // Monotonic token so a slow fetch for a previous path can't render
  // into (or flip the state of) a newer document's view.
  const reqRef = useRef(0);

  useEffect(() => {
    const req = ++reqRef.current;
    setState('loading');
    (async () => {
      try {
        const bytes = await window.api.readFileBinary(path);
        if (!bytes) throw new Error('read failed');
        if (req !== reqRef.current || !hostRef.current) return;
        hostRef.current.innerHTML = '';
        await renderAsync(bytes, hostRef.current);
        if (req !== reqRef.current) return;
        setState('ready');
      } catch {
        if (req === reqRef.current) setState('error');
      }
    })();
  }, [path]);

  return (
    <div className="file-docx-viewer">
      {state === 'loading' && (
        <div className="file-docx-status">Rendering document…</div>
      )}
      {state === 'error' && (
        <div className="file-docx-status">
          Couldn&apos;t render this document. Legacy .doc files and corrupt
          archives aren&apos;t supported — only .docx.
        </div>
      )}
      <div
        ref={hostRef}
        className="file-docx-pages"
        style={state === 'ready' ? undefined : { display: 'none' }}
      />
    </div>
  );
}
