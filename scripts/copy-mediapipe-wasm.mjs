// Copia los binarios WASM de MediaPipe a public/ para servirlos localmente
// (así la versión siempre coincide con la del paquete instalado).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dest = resolve(root, 'public/mediapipe/wasm');

if (!existsSync(src)) {
  console.error('No se encontró @mediapipe/tasks-vision. Ejecutá `npm install` primero.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('WASM de MediaPipe copiado a public/mediapipe/wasm');
