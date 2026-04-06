import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3001' } },
  resolve: { alias: { '@ruin/engine': '../engine/src/index.ts' } },
  build: { outDir: 'dist' },
});
