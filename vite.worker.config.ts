import { defineConfig } from 'vite';

// Status detection worker — runs on a Node.js worker thread spawned from the
// main process. Bundle output ends up alongside main.js in .vite/build/.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['worker_threads'],
    },
    lib: {
      entry: 'src/main/status-worker.ts',
      formats: ['cjs'],
      fileName: () => 'status-worker.js',
    },
  },
});
