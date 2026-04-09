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
      };

      document.body.style.cursor =
        direction === 'horizontal' ? 'col-resize' : 'row-resize';
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
