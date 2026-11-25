import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const bridgeTarget = process.env.VITE_BRIDGE_URL ?? 'http://127.0.0.1:3333';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: bridgeTarget,
        changeOrigin: false,
      },
      '/ws': {
        target: bridgeTarget.replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
