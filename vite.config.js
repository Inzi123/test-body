import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Por defecto se sirve por HTTPS y en toda la red local, para poder abrir la app
// desde el celular u otra computadora (los navegadores sólo permiten usar la
// cámara en HTTPS o en localhost). `npm run dev:local` usa HTTP sólo en esta PC.
export default defineConfig(({ mode }) => {
  const localOnly = mode === 'local';
  return {
    base: './',
    plugins: localOnly ? [] : [basicSsl({ name: 'body-mirror' })],
    server: { host: !localOnly, port: 5173 },
    preview: { host: true, port: 4173 },
    optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  };
});
