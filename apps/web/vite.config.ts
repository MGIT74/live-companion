import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': 'http://localhost:4000', '/health': 'http://localhost:4000' } },
  build: { outDir: 'dist', sourcemap: false },
});
