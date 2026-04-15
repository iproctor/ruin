import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@ruin/engine': path.resolve(__dirname, '../engine/src/index.ts') } },
  test: { environment: 'jsdom' },
});
