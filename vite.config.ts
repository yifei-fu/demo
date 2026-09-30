import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', sourcemap: false },
  worker: { format: 'es' },
  server: { port: 5171, strictPort: true, host: true },
  preview: { port: 5171, strictPort: true },
});
