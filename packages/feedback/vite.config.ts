import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: { index: resolve(import.meta.dirname, 'src/index.ts'), react: resolve(import.meta.dirname, 'src/react/index.ts'), github: resolve(import.meta.dirname, 'src/github/index.ts'), settings: resolve(import.meta.dirname, 'src/settings/index.ts') },
      formats: ['es', 'cjs'],
      fileName: (format, name) => `${name}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
  },
});
