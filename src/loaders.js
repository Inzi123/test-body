import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

export const MODEL_EXTENSIONS = ['vrm', 'glb', 'gltf', 'fbx', 'obj'];
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tga|tiff?|dds|ktx2?)$/i;
// Textura de 1×1 blanca para las texturas que faltan (rutas absolutas del creador, etc.).
const BLANK_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

// Decodificador para modelos comprimidos con Draco (opción "Compresión" del exportador de Blender).
let dracoLoader = null;
function getDracoLoader() {
  dracoLoader ??= new DRACOLoader().setDecoderPath(new URL('draco/', document.baseURI).href);
  return dracoLoader;
}

const extensionOf = (name) => name.split('.').pop().toLowerCase();
const basename = (url) => decodeURIComponent(url.split('?')[0].split(/[\\/]/).pop()).toLowerCase();

/**
 * Carga un modelo a partir de los archivos elegidos por el usuario. Se pueden
 * incluir archivos auxiliares (.mtl, .bin, texturas): se resuelven por nombre.
 * @returns {Promise<{object: THREE.Object3D, vrm: any, format: string, name: string}>}
 */
export async function loadModelFromFiles(fileList) {
  const files = [...fileList];
  const main =
    MODEL_EXTENSIONS.map((ext) => files.find((f) => extensionOf(f.name) === ext)).find(Boolean) ?? null;
  if (!main) throw new Error('Elegí un archivo .glb, .gltf, .vrm, .fbx u .obj');

  const urls = new Map();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const blobUrls = new Set(urls.values());
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (blobUrls.has(url) || url.startsWith('data:')) return url;
    const name = basename(url);
    if (urls.has(name)) return urls.get(name);
    if (IMAGE_RE.test(name)) return BLANK_IMAGE;
    return url;
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));

  try {
    const format = extensionOf(main.name);
    const mtl = files.find((f) => extensionOf(f.name) === 'mtl');
    const result = await loadWithManager(urls.get(main.name.toLowerCase()), format, manager, mtl && urls.get(mtl.name.toLowerCase()));
    return { ...result, format, name: main.name };
  } finally {
    // Las texturas ya se decodificaron; se pueden liberar las URLs más tarde.
    setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
}

export async function loadModelFromUrl(url) {
  const format = extensionOf(url);
  const result = await loadWithManager(url, format, new THREE.LoadingManager());
  return { ...result, format, name: basename(url) };
}

async function loadWithManager(url, format, manager, mtlUrl) {
  if (format === 'fbx') {
    return { object: await new FBXLoader(manager).loadAsync(url), vrm: null };
  }
  if (format === 'obj') {
    const loader = new OBJLoader(manager);
    if (mtlUrl) {
      const materials = await new MTLLoader(manager).loadAsync(mtlUrl);
      materials.preload();
      loader.setMaterials(materials);
    }
    const object = await loader.loadAsync(url);
    fixObjMaterials(object, !!mtlUrl);
    return { object, vrm: null };
  }
  const loader = new GLTFLoader(manager);
  loader.setDRACOLoader(getDracoLoader());
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false }));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm ?? null;
  return { object: vrm ? vrm.scene : gltf.scene, vrm };
}

/** Materiales de OBJ: valores por defecto razonables y córneas transparentes. */
function fixObjMaterials(object, hasMtl) {
  const fallback = new THREE.MeshStandardMaterial({ color: 0xc8a383, roughness: 0.65 });
  object.traverse((o) => {
    if (!o.isMesh) return;
    if (!hasMtl) {
      o.material = fallback;
      return;
    }
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (/cornea|refraction|eyes?_?outer|tearline|eye_?moisture|eyewet/i.test(m.name)) {
        m.transparent = true;
        m.opacity = 0.12;
        m.depthWrite = false;
      }
    }
  });
}
