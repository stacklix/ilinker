import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiHost = process.env.HOST || env.HOST || '127.0.0.1';
  const apiPort = process.env.PORT || env.PORT || '3000';
  const apiTarget = `http://${apiHost === '0.0.0.0' ? '127.0.0.1' : apiHost}:${apiPort}`;
  return {
  plugins: [react()],
  build: { outDir: 'dist/web' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget },
      '/hook': { target: apiTarget },
    },
  },
  };
});
