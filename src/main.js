import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { DrawingUtils, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { CameraTracker, detectPoseInImage } from './tracking.js';
import {
  HAND_LANDMARK_COUNT,
  LANDMARK_COUNT,
  LM,
  assignHands,
  createPointArray,
  handToAvatarSpace,
  toAvatarSpace,
} from './landmarks.js';
import { LandmarkFilter } from './filters.js';
import { Retargeter } from './retarget.js';
import { createMannequin } from './mannequin.js';
import { loadModelFromFiles, loadModelFromUrl } from './loaders.js';
import { prepareModel } from './model.js';
import { describeBoneMap } from './humanoid.js';

const SAMPLE_URL = 'https://threejs.org/examples/models/gltf/Xbot.glb';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Escena

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.shadowMap.enabled = true;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171f);
scene.fog = new THREE.Fog(0x14171f, 12, 30);

const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.5;
controls.maxDistance = 15;

scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a3128, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2.5, 5, 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -2.5;
sun.shadow.camera.right = 2.5;
sun.shadow.camera.top = 3;
sun.shadow.camera.bottom = -1;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
rim.position.set(-3, 3, -3);
scene.add(rim);

const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0x1c2029, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(12, 24, 0x3a4152, 0x262b38);
grid.position.y = 0.001;
scene.add(grid);

const VIEW_TARGET = new THREE.Vector3(0, 0.95, 0);
const VIEW_DIRECTION = new THREE.Vector3(0, 0.35, 4.4).normalize();

// Zona de la pantalla que no tapa el panel (a la derecha en escritorio, abajo en el celular).
function freeArea() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const panel = $('panel');
  const open = !panel.classList.contains('collapsed');
  const mobile = w <= 760;
  const shiftX = open && !mobile ? (panel.offsetWidth + 24) / 2 : 0;
  const shiftY = open && mobile ? panel.offsetHeight / 2 : 0;
  return { w, h, shiftX, shiftY, freeW: w - shiftX * 2, freeH: h - shiftY * 2 };
}

/** Distancia para que entre una persona con los brazos levantados en la zona libre. */
function fitDistance() {
  const { w, h, freeW, freeH } = freeArea();
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const byHeight = 1.3 / (t * (freeH / h));
  const byWidth = 0.8 / (t * camera.aspect * (freeW / w));
  return Math.max(byHeight, byWidth, 2.5);
}

function resetView() {
  controls.target.copy(VIEW_TARGET);
  camera.position.copy(VIEW_TARGET).addScaledVector(VIEW_DIRECTION, fitDistance());
  controls.update();
}

// Desplaza el centro de la vista para que el avatar no quede detrás del panel.
function resize() {
  const { w, h, shiftX, shiftY } = freeArea();
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.setViewOffset(w, h, shiftX, shiftY, w, h);
  camera.updateProjectionMatrix();
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, fitDistance());
  controls.update();
}
window.addEventListener('resize', resize);
resetView();
resize();

// ---------------------------------------------------------------------------
// Estado

const options = { torso: true, head: true, arms: true, hands: true, legs: true, move: false };
let mirror = true;
let current = null; // { container, boneMap, vrm, retargeter, base, autoRigged, name }
let skeletonHelper = null;
let exporting = false; // durante la exportación el modelo queda en su pose de reposo

const tracker = new CameraTracker($('video'));
const points = createPointArray();
const visibility = new Float32Array(LANDMARK_COUNT);
const inFrame = new Uint8Array(LANDMARK_COUNT);
const filter = new LandmarkFilter(LANDMARK_COUNT);
// Manos del detector de manos, ya asignadas al lado del avatar.
const handPoints = { left: createPointArray(HAND_LANDMARK_COUNT), right: createPointArray(HAND_LANDMARK_COUNT) };
const handFilters = { left: new LandmarkFilter(HAND_LANDMARK_COUNT), right: new LandmarkFilter(HAND_LANDMARK_COUNT) };
const handSeen = { left: 0, right: 0 }; // momento de la última detección (lado del avatar)
const personHandSeen = { left: 0, right: 0 }; // ídem, lado de la persona
const setSmoothing = (value) => [filter, handFilters.left, handFilters.right].forEach((f) => f.setSmoothing(value));
const resetFilters = () => [filter, handFilters.left, handFilters.right].forEach((f) => f.reset());
setSmoothing(Number($('smoothing-range').value));
let hasPose = false;
let lastPoseImage = null; // puntos 2D del último cuadro (para depurar)
let lastPoseTime = 0;
let lastDetectionTime = 0;
let rootOffsetX = 0;
let rootOffsetY = 0;
let shoulderImageX = 0.5;
let metersPerImageUnit = 0;

const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const drawing = new DrawingUtils(overlayCtx);

// ---------------------------------------------------------------------------
// Mensajes

let statusTimer = null;
function setStatus(text, { error = false, sticky = false } = {}) {
  const el = $('status');
  clearTimeout(statusTimer);
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.toggle('visible', !!text);
  if (text && !sticky) statusTimer = setTimeout(() => el.classList.remove('visible'), error ? 7000 : 3500);
}

async function busy(text, task) {
  setStatus(text, { sticky: true });
  document.body.style.cursor = 'progress';
  try {
    return await task((msg) => setStatus(msg, { sticky: true }));
  } catch (err) {
    console.error(err);
    const message = err instanceof Error && err.message
      ? err.message
      : 'No se pudo cargar un archivo necesario. Revisá que la ventana de "npm run dev" siga abierta y recargá la página (F5).';
    setStatus(message, { error: true });
    return undefined;
  } finally {
    document.body.style.cursor = '';
  }
}

// ---------------------------------------------------------------------------
// Modelo

function disposeObject(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

function setModel(prepared, name) {
  if (current) {
    scene.remove(current.container);
    disposeObject(current.container);
  }
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.dispose?.();
    skeletonHelper = null;
  }
  const { container, boneMap } = prepared;
  scene.add(container);
  const retargeter = new Retargeter(container, boneMap);
  current = { ...prepared, retargeter, name, base: container.position.clone() };
  rootOffsetX = 0;
  rootOffsetY = 0;
  updateSkeletonHelper();
  applyVertexColors();
  renderModelInfo();
}

function renderModelInfo() {
  const info = $('model-info');
  const report = describeBoneMap(current.boneMap);
  const found = report.filter((r) => r.ok).length;
  const essential = ['hips', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
  const missingEssential = report.filter((r) => essential.includes(r.key) && !r.ok);
  info.innerHTML = '';
  const title = document.createElement('div');
  title.innerHTML = `<strong></strong>`;
  title.querySelector('strong').textContent = current.name;
  info.appendChild(title);
  const tag = document.createElement('span');
  tag.className = 'tag' + (missingEssential.length ? ' warn' : '');
  tag.textContent = current.autoRigged
    ? `Auto-rig: articulaciones por ${current.rigMethod}`
    : `${found}/${report.length} huesos reconocidos`;
  info.appendChild(tag);

  const list = $('bones-list');
  list.innerHTML = '';
  for (const r of report) {
    const li = document.createElement('li');
    li.className = r.ok ? '' : 'missing';
    const a = document.createElement('span');
    a.textContent = (r.ok ? '✓ ' : '✗ ') + r.key;
    const b = document.createElement('span');
    b.textContent = r.name || '—';
    b.title = r.name;
    li.append(a, b);
    list.appendChild(li);
  }
  $('export-button').hidden = !current.autoRigged;
}

/** Activa/desactiva los colores por vértice en los materiales que los usan. */
function applyVertexColors() {
  if (!current) return;
  const on = $('vertex-colors-check').checked;
  current.container.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      m.userData.vertexColors ??= m.vertexColors;
      if (!m.userData.vertexColors) continue;
      m.vertexColors = on;
      m.needsUpdate = true;
    }
  });
}

function updateSkeletonHelper() {
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.dispose?.();
    skeletonHelper = null;
  }
  if ($('skeleton-check').checked && current) {
    skeletonHelper = new THREE.SkeletonHelper(current.container);
    skeletonHelper.material.depthTest = false;
    skeletonHelper.material.transparent = true;
    scene.add(skeletonHelper);
  }
}

function loadMannequin() {
  const { root, boneMap } = createMannequin();
  const container = new THREE.Group();
  container.add(root);
  setModel({ container, boneMap, vrm: null, autoRigged: false }, 'Maniquí');
}

async function useLoaded(loadedPromise) {
  await busy('Cargando modelo…', async (status) => {
    const loaded = await loadedPromise;
    const prepared = await prepareModel(loaded, { detect: detectPoseInImage, onStatus: status });
    setModel(prepared, loaded.name);
    setStatus(prepared.autoRigged ? 'Modelo riggeado automáticamente ✔' : 'Modelo cargado ✔');
  });
}

$('file-input').addEventListener('change', (e) => {
  const files = e.target.files;
  if (files?.length) useLoaded(loadModelFromFiles(files));
  e.target.value = '';
});
$('mannequin-button').addEventListener('click', loadMannequin);
$('sample-button').addEventListener('click', () => useLoaded(loadModelFromUrl(SAMPLE_URL)));

$('export-button').addEventListener('click', async () => {
  if (!current) return;
  exporting = true;
  await busy('Exportando…', async () => {
    current.retargeter.resetPose();
    current.container.position.copy(current.base);
    const buffer = await new GLTFExporter().parseAsync(current.container, { binary: true });
    const url = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = current.name.replace(/\.[^.]+$/, '') + '-rigged.glb';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus('GLB descargado ✔');
  });
  exporting = false;
});

// Arrastrar y soltar archivos.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('dropzone').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('dropzone').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  if (e.dataTransfer?.files?.length) useLoaded(loadModelFromFiles(e.dataTransfer.files));
});

// ---------------------------------------------------------------------------
// Cámara

async function refreshCameraList() {
  const select = $('camera-select');
  const cameras = await CameraTracker.listCameras();
  const selected = select.value;
  select.innerHTML = '<option value="">Predeterminada</option>';
  cameras.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Cámara ${i + 1}`;
    select.appendChild(opt);
  });
  if ([...select.options].some((o) => o.value === selected)) select.value = selected;
}

async function startCamera() {
  const button = $('camera-button');
  button.disabled = true;
  await busy('Cargando detector de pose…', async (status) => {
    await tracker.setVariant($('variant-select').value);
    if (options.hands) {
      status('Cargando detector de manos…');
      await tracker.setHands(true);
    }
    status('Abriendo la cámara…');
    await tracker.start($('camera-select').value || undefined);
    resetFilters();
    personHandSeen.left = personHandSeen.right = 0;
    $('preview').hidden = !$('preview-check').checked;
    button.textContent = 'Detener cámara';
    button.classList.add('active');
    setStatus('¡Listo! Ponete de frente a la cámara, con el cuerpo a la vista.');
    refreshCameraList();
  });
  button.disabled = false;
}

function stopCamera() {
  tracker.stop();
  hasPose = false;
  $('preview').hidden = true;
  $('camera-button').textContent = 'Iniciar cámara';
  $('camera-button').classList.remove('active');
}

$('camera-button').addEventListener('click', () => (tracker.running ? stopCamera() : startCamera()));
$('camera-select').addEventListener('change', () => tracker.running && startCamera());
$('variant-select').addEventListener('change', async () => {
  if (!tracker.running) return;
  await busy('Cambiando el modelo de detección…', async () => {
    await tracker.setVariant($('variant-select').value);
    resetFilters();
    setStatus('Detector actualizado ✔');
  });
});
$('mirror-check').addEventListener('change', (e) => {
  mirror = e.target.checked;
  $('preview').classList.toggle('mirror', mirror);
  resetFilters();
});
$('preview').classList.toggle('mirror', mirror);
$('calibrate-button').addEventListener('click', () => {
  if (current && hasPose && current.retargeter.calibrateHead()) setStatus('Cabeza calibrada ✔');
  else setStatus('Iniciá la cámara y mirá de frente para calibrar.', { error: true });
});

for (const input of document.querySelectorAll('[data-option]')) {
  input.addEventListener('change', () => {
    options[input.dataset.option] = input.checked;
    if (input.dataset.option === 'hands' && tracker.running) {
      busy('Cargando detector de manos…', async () => {
        await tracker.setHands(input.checked);
        setStatus(input.checked ? 'Manos activadas ✔' : 'Manos desactivadas');
      });
    }
  });
}
$('smoothing-range').addEventListener('input', (e) => setSmoothing(Number(e.target.value)));
$('preview-check').addEventListener('change', (e) => ($('preview').hidden = !e.target.checked || !tracker.running));
$('landmarks-check').addEventListener('change', (e) => {
  overlay.hidden = !e.target.checked;
});
$('skeleton-check').addEventListener('change', updateSkeletonHelper);
$('vertex-colors-check').addEventListener('change', applyVertexColors);
$('reset-view-button').addEventListener('click', resetView);
$('panel-toggle').addEventListener('click', () => {
  $('panel').classList.toggle('collapsed');
  resize();
});

// ---------------------------------------------------------------------------
// Bucle principal

function drawOverlay(imageLandmarks, handLandmarks = []) {
  const v = $('video');
  if (overlay.width !== v.videoWidth || overlay.height !== v.videoHeight) {
    overlay.width = v.videoWidth;
    overlay.height = v.videoHeight;
  }
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (overlay.hidden) return;
  const scale = overlay.width / 640;
  if (imageLandmarks) {
    drawing.drawConnectors(imageLandmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#4f8cff', lineWidth: 3 * scale });
    drawing.drawLandmarks(imageLandmarks, {
      color: '#ffffff',
      fillColor: '#ff7a59',
      lineWidth: 1,
      radius: (d) => ((d.from?.visibility ?? 1) > 0.5 ? 4 * scale : 2 * scale),
    });
  }
  for (const hand of handLandmarks) {
    drawing.drawConnectors(hand, HandLandmarker.HAND_CONNECTIONS, { color: '#46c37b', lineWidth: 2 * scale });
    drawing.drawLandmarks(hand, { color: '#46c37b', fillColor: '#ffffff', lineWidth: 1, radius: 2 * scale });
  }
}

/** Convierte y filtra las manos ya asignadas a cada lado de la persona. */
function processHands(handResult, assigned, dt, now) {
  const worlds = handResult?.worldLandmarks ?? [];
  for (const personSide of ['left', 'right']) {
    const h = assigned[personSide];
    if (h === null || !worlds[h]) continue;
    // En modo espejo la mano izquierda de la persona mueve la mano derecha del avatar.
    const avatarSide = mirror ? (personSide === 'left' ? 'right' : 'left') : personSide;
    handToAvatarSpace(worlds[h], mirror, handPoints[avatarSide]);
    handFilters[avatarSide].apply(handPoints[avatarSide], dt);
    handSeen[avatarSide] = now;
    personHandSeen[personSide] = now;
  }
}

/**
 * Manos que el detector de manos venía viendo y perdió: si la muñeca cae sobre
 * el torso, casi seguro pasó por detrás del cuerpo.
 */
function lostHands(handResult, assigned) {
  const lost = new Set();
  if (!handResult) return lost;
  for (const side of ['left', 'right']) {
    // Se exige haberla visto alguna vez: si la persona está lejos, el detector de
    // manos nunca las encuentra y no hay que asumir nada.
    if (assigned[side] === null && personHandSeen[side] > 0) lost.add(side);
  }
  return lost;
}

function processDetection({ pose, hands }, now) {
  const world = pose.worldLandmarks?.[0];
  const image = pose.landmarks?.[0];
  if (!world || !image) {
    hasPose = false;
    drawOverlay(null, hands?.landmarks);
    return;
  }
  const dt = Math.min(lastDetectionTime ? (now - lastDetectionTime) / 1000 : 1 / 30, 0.25);
  lastDetectionTime = now;
  lastPoseImage = image;
  const assigned = assignHands(hands?.landmarks, image);
  toAvatarSpace(world, image, mirror, points, visibility, inFrame, lostHands(hands, assigned));
  filter.apply(points, dt, visibility);
  processHands(hands, assigned, dt, now);
  hasPose = true;
  lastPoseTime = now;
  drawOverlay(image, hands?.landmarks);

  // Para "Desplazarse": posición horizontal del cuerpo en la imagen, en metros.
  const v = $('video');
  const aspect = v.videoWidth / v.videoHeight || 4 / 3;
  const ls = image[LM.leftShoulder];
  const rs = image[LM.rightShoulder];
  const widthImage = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
  const wl = world[LM.leftShoulder];
  const wr = world[LM.rightShoulder];
  const widthWorld = Math.hypot(wl.x - wr.x, wl.y - wr.y, wl.z - wr.z);
  if (widthImage > 0.02) metersPerImageUnit = widthWorld / widthImage;
  shoulderImageX = (ls.x + rs.x) / 2;
}

let fpsFrames = 0;
let fpsTime = performance.now();
const timer = new THREE.Timer();
timer.connect(document);

function frame(timestamp) {
  const now = performance.now();
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);

  const result = tracker.detect();
  if (result) {
    processDetection(result, now);
    fpsFrames++;
  }
  if (now - fpsTime > 1000) {
    $('fps').textContent = `${Math.round((fpsFrames * 1000) / (now - fpsTime))} fps · ${hasPose ? 'cuerpo detectado' : 'buscando…'}`;
    fpsFrames = 0;
    fpsTime = now;
  }

  if (current && !exporting) {
    const live = tracker.running && hasPose && now - lastPoseTime < 600;
    const hands = {
      left: live && now - handSeen.left < 300 ? handPoints.left : null,
      right: live && now - handSeen.right < 300 ? handPoints.right : null,
    };
    current.retargeter.update(live ? points : null, visibility, options, dt, { inFrame, hands });

    const k = 1 - Math.exp(-dt * 6);
    let targetX = 0;
    if (live && options.move && metersPerImageUnit > 0) {
      const aspect = $('video').videoWidth / $('video').videoHeight || 4 / 3;
      targetX = THREE.MathUtils.clamp((shoulderImageX - 0.5) * aspect * metersPerImageUnit, -2.5, 2.5);
      if (mirror) targetX = -targetX;
    }
    rootOffsetX += (targetX - rootOffsetX) * k;
    rootOffsetY += (current.retargeter.groundOffset() - rootOffsetY) * k;
    current.container.position.set(current.base.x + rootOffsetX, current.base.y + rootOffsetY, current.base.z);
    current.vrm?.update(dt);
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

loadMannequin();
requestAnimationFrame(frame);

// Para depurar desde la consola.
window.bodyMirror = { THREE, points, visibility, inFrame, scene, camera, controls, tracker, get model() { return current; }, get lastPoseImage() { return lastPoseImage; }, useLoaded, loadModelFromFiles };
