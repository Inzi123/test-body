// Copia a public/ los binarios WASM que se cargan en tiempo de ejecución
// (MediaPipe y el decodificador Draco de three.js), así la versión siempre
// coincide con la de los paquetes instalados.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  ['node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe/wasm'],
  ['node_modules/three/examples/jsm/libs/draco/gltf', 'public/draco'],
];

for (const [from, to] of copies) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    console.error(`No se encontró ${from}. Ejecutá \`npm install\` primero.`);
    process.exit(1);
  }
  mkdirSync(resolve(root, to), { recursive: true });
  cpSync(src, resolve(root, to), { recursive: true });
}
console.log('WASM de MediaPipe y Draco copiados a public/');
