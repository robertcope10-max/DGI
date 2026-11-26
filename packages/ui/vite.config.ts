import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const shim = (f: string) => fileURLToPath(new URL(`./src/demo/shims/${f}`, import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  // `vite build --mode demo`: a self-contained build with the framework running in the page.
  ...(mode === 'demo'
    ? {
        base: './',
        build: { outDir: 'dist-demo' },
        resolve: {
          alias: {
            'node:crypto': shim('crypto.ts'),
            'node:fs': shim('fs.ts'),
            'node:path': shim('path.ts'),
            jose: shim('jose.ts'),
          },
        },
      }
    : {}),
}));
