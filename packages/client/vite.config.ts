import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://localhost:3001' } },
  resolve: { alias: { '@ruin/engine': '../engine/src/index.ts' } },
  build: { outDir: 'dist' },
});
