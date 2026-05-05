import { useEffect, useState } from 'react';
import mermaid from 'mermaid';

// One-time mermaid setup. `startOnLoad: false` means we only render
// charts when our component asks (no automatic DOM scan); the dark
// theme reads cleanly on the app's dark chrome.
let mermaidInitialized = false;
function ensureMermaidInitialized() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
    fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
  });
  mermaidInitialized = true;
}

let mermaidIdSeq = 0;

/**
 * Render one mermaid block. Async because `mermaid.render` is async and
 * returns SVG markup. On invalid input we surface the parser error
 * inline so the user can fix the source.
 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    ensureMermaidInitialized();
    const id = `mermaid-${++mermaidIdSeq}`;
    mermaid.render(id, code).then(
      (result) => { if (!cancelled) { setSvg(result.svg); setError(''); } },
      (err) => { if (!cancelled) { setSvg(''); setError(err instanceof Error ? err.message : String(err)); } },
    );
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <pre className="readme-mermaid-error" title="Mermaid parse error">
        {`Mermaid error: ${error}\n\n${code}`}
      </pre>
    );
  }
  if (!svg) return <div className="readme-mermaid-loading">rendering diagram…</div>;
  return (
    <div
      className="readme-mermaid"
      // mermaid output is trusted (we set securityLevel:'strict' above);
      // this is the standard react-markdown / mermaid integration.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
