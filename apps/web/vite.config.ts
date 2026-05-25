import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const currentServerPort =
  process.env.CURRENT_PORT ?? process.env.CURRENT_SERVER_PORT ?? process.env.PORT ?? '6414';
const currentServerOrigin =
  process.env.CURRENT_SERVER_ORIGIN ?? `http://127.0.0.1:${currentServerPort}`;
const currentServerWebSocketOrigin = currentServerOrigin.replace(/^http/i, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: currentServerOrigin,
        changeOrigin: true,
        xfwd: true,
      },
      '/gateway': {
        target: currentServerWebSocketOrigin,
        ws: true,
        xfwd: true,
      },
    },
  },
});
