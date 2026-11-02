import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/iife.ts'),
      formats: ['iife'],
      name: 'PinHelpFeedbackBundle',
      fileName: () => 'feedback.iife.js',
    },
  },
});
