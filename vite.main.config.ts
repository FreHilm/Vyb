import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty', 'archiver', 'adm-zip', '@frehilm/ordna-core', '@frehilm/ordna-web'],
    },
  },
});
