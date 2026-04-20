import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  build: {
    // xterm.js has code patterns that break under esbuild minification
    // (causes "ReferenceError: i is not defined" in requestMode when vi/TUI
    // apps send DEC request-mode escape sequences). Use terser with name
    // preservation for xterm, or disable minification entirely.
    minify: 'terser',
    terserOptions: {
      // Keep function and class names — xterm.js has internal references
      // that break if names are mangled too aggressively
      keep_fnames: true,
      keep_classnames: true,
      mangle: {
        // Don't rename these — xterm.js uses them by name internally
        reserved: ['requestMode', 'parse', '_action', '_innerWrite'],
      },
    },
  },
});
