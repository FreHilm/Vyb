import { useCallback, useRef } from 'react';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
}

export function ResizeHandle({ direction, onResize }: ResizeHandleProps) {
  const startPos = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startPos.current =
        direction === 'horizontal' ? e.clientX : e.clientY;

      // Transparent fullscreen overlay sits above `<webview>` for the
      // duration of the drag. Without it, mouse events get captured
      // by the webview's own renderer process as soon as the cursor
      // crosses into web content — the host window's mousemove
      // listener stops firing and the resize stalls until the cursor
      // re-enters host-rendered DOM. The overlay intercepts those
      // events first so they bubble up to our handler normally.
      const cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
      const overlay = document.createElement('div');
      overlay.setAttribute('data-resize-overlay', '');
      overlay.style.cssText = `position:fixed;inset:0;z-index:99999;cursor:${cursor};background:transparent;`;
      document.body.appendChild(overlay);

      const handleMouseMove = (ev: MouseEvent) => {
        const current =
          direction === 'horizontal' ? ev.clientX : ev.clientY;
        const delta = current - startPos.current;
        startPos.current = current;
        onResize(delta);
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        overlay.remove();
      };

      document.body.style.cursor = cursor;
      document.body.style.userSelect = 'none';

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [direction, onResize],
  );

  const className =
    direction === 'horizontal'
      ? 'resize-handle resize-handle-h'
      : 'resize-handle resize-handle-v';

  return <div className={className} onMouseDown={handleMouseDown} />;
}
