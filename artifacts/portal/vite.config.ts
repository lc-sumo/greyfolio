import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/auth': { target: api, changeOrigin: false },
    },
  },
  build:
    process.env.VITE_DEMO === '1'
      ? { outDir: 'dist-demo', sourcemap: false, rollupOptions: { output: { inlineDynamicImports: true } } }
      : { outDir: 'dist', sourcemap: true },
});
