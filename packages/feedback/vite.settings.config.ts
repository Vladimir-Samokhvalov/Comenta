import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// settings.iife.js: <comenta-settings> for the owner's page (not part of the visitor bundle)
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/settings-iife.ts'),
      formats: ['iife'],
      name: 'ComentaSettingsBundle',
      fileName: () => 'settings.iife.js',
    },
  },
});
