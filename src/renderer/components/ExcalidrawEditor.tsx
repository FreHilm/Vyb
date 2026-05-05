import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef, type ComponentProps } from 'react';
import { Excalidraw, MainMenu, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// Excalidraw doesn't re-export ExcalidrawImperativeAPI / InitialData types
// from its main entry, and our tsconfig uses node module resolution so
// `@excalidraw/excalidraw/types` won't resolve. Derive both from the public
// component props instead.
type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0];
type ExcalidrawInitialDataState = Exclude<
  Awaited<NonNullable<ExcalidrawProps['initialData']> extends infer T ? T extends () => infer R ? Awaited<R> : T : never>,
  null
>;

export interface ExcalidrawEditorHandle {
  /** Serialize the current scene into the on-disk JSON format. */
  serialize: () => string;
}

interface ExcalidrawEditorProps {
  /** File path — used as the React key so a tab switch fully remounts the
   * editor with fresh initialData (Excalidraw doesn't reactively re-read
   * `initialData` after mount). */
  filePath: string;
  /** Raw file contents from disk (or cache). Empty string is treated as a
   * fresh / blank scene. */
  initialContent: string;
  theme: 'light' | 'dark';
  /** Fires whenever the scene meaningfully changes vs the loaded baseline. */
  onModifiedChange: (modified: boolean) => void;
  /** Cmd+S inside the canvas — let the parent run the same save flow it
   * uses for the toolbar Save button. */
  onSaveRequested: () => void;
}

/** Build an Excalidraw initialData object from a raw .excalidraw JSON file.
 * Returns null for empty/invalid content so Excalidraw shows a blank scene. */
function parseInitialData(raw: string): ExcalidrawInitialDataState | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      elements: parsed.elements ?? [],
      appState: parsed.appState ?? undefined,
      files: parsed.files ?? undefined,
      scrollToContent: true,
    };
  } catch {
    return null;
  }
}

export const ExcalidrawEditor = forwardRef<ExcalidrawEditorHandle, ExcalidrawEditorProps>(
  function ExcalidrawEditor(
    { filePath, initialContent, theme, onModifiedChange, onSaveRequested },
    ref,
  ) {
    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    const baselineRef = useRef<string>(initialContent);
    const [, setIsModified] = useState(false);

    const initialData = useMemo(() => parseInitialData(initialContent), [initialContent]);

    const serializeCurrent = (): string => {
      const api = apiRef.current;
      if (!api) return baselineRef.current;
      return serializeAsJSON(
        api.getSceneElements(),
        api.getAppState(),
        api.getFiles(),
        'local',
      );
    };

    useImperativeHandle(ref, () => ({
      serialize: serializeCurrent,
    }), []);

    // Reset baseline when the file changes (parent remounts via key, but
    // belt-and-braces in case it doesn't).
    useEffect(() => {
      baselineRef.current = initialContent;
      setIsModified(false);
      onModifiedChange(false);
    }, [filePath, initialContent]);

    // Cmd+S inside the canvas → parent save flow.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          e.stopPropagation();
          onSaveRequested();
        }
      };
      // Capture so we beat Excalidraw's own keymap (which would otherwise
      // pop up the export dialog on Cmd+S).
      window.addEventListener('keydown', onKey, true);
      return () => window.removeEventListener('keydown', onKey, true);
    }, [onSaveRequested]);

    return (
      <div className="excalidraw-host">
        <Excalidraw
          excalidrawAPI={(api) => { apiRef.current = api; }}
          initialData={initialData}
          theme={theme}
          // Empty top-right slot — clears the default Help/Library trigger
          // since persistence is handled by the host (Vyb's File Explorer).
          renderTopRightUI={() => null}
          onChange={() => {
            const current = serializeCurrent();
            const next = current !== baselineRef.current;
            setIsModified((prev) => {
              if (prev !== next) onModifiedChange(next);
              return next;
            });
          }}
          UIOptions={{
            canvasActions: {
              saveToActiveFile: false,
              loadScene: false,
            },
          }}
        >
          {/* Curated hamburger menu — Vyb owns persistence (Cmd+S / tab
              bar Save), so we drop LoadScene + SaveToActiveFile and keep
              the actions that still make sense locally. Re-order, remove,
              or add custom items as needed. */}
          <MainMenu>
            <MainMenu.DefaultItems.CommandPalette />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.Export />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.ToggleTheme />
          </MainMenu>
        </Excalidraw>
      </div>
    );
  },
);
