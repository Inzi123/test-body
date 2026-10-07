import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` sirve por HTTPS para poder usar la cámara desde otro
// dispositivo de la red (los navegadores sólo permiten la cámara en HTTPS o localhost).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: { host: mode === 'https' ? true : undefined },
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
}));
