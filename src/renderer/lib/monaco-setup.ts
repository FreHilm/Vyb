// Monaco worker wiring for the Vite + Electron renderer.
//
// Monaco offloads language services to web workers. For the spike we
// only need editing + syntax highlighting (Monarch tokenization runs
// on the main thread), so pointing every worker request at the base
// editor worker is enough and avoids bundling per-language service
// workers. Vite turns `new Worker(new URL(..., import.meta.url))` /
// the `?worker` import into a properly-bundled worker chunk.
//
// Importing this module for its side effect (it sets
// self.MonacoEnvironment) must happen before any monaco editor is
// created. MonacoFileEditor imports it at module load.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Monaco's own types already declare `self.MonacoEnvironment` as an
// optional `Environment`, so we assign rather than re-declare the
// global (re-declaring conflicts with the bundled type).
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

export {};
