import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

// Los .wasm se sirven desde public/ (ver scripts/copy-mediapipe-wasm.mjs). Si no se
// pueden cargar desde ahí, se usa la misma versión publicada en un CDN.
const MEDIAPIPE_VERSION = '0.10.21'; // igual a la de package.json
const WASM_SOURCES = [
  new URL('mediapipe/wasm', document.baseURI).href.replace(/\/$/, ''),
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
];

export const MODEL_URLS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
};

const LOAD_ERROR =
  'No se pudo cargar el detector de pose. Revisá que la ventana de "npm run dev" siga abierta y que haya conexión a internet, y recargá la página (F5).';

let wasmSource = 0; // índice de la fuente que funcionó

export async function createPoseLandmarker(variant = 'full', runningMode = 'VIDEO') {
  let lastError = null;
  for (let i = wasmSource; i < WASM_SOURCES.length; i++) {
    try {
      const landmarker = await createPoseLandmarkerFrom(WASM_SOURCES[i], variant, runningMode);
      wasmSource = i;
      return landmarker;
    } catch (err) {
      console.warn(`MediaPipe: no se pudo cargar desde ${WASM_SOURCES[i]}`, err);
      lastError = err;
    }
  }
  // Los fallos de carga de scripts llegan como un Event sin mensaje.
  const message = lastError instanceof Error ? lastError.message : '';
  throw new Error(message && !/fetch|load/i.test(message) ? message : LOAD_ERROR);
}

async function createPoseLandmarkerFrom(wasmPath, variant, runningMode) {
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URLS[variant], delegate },
    runningMode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('MediaPipe: GPU no disponible, uso CPU.', err);
    return PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/** Detector de imágenes fijas (para el auto-rig). Se crea una sola vez. */
let imageLandmarkerPromise = null;
export async function detectPoseInImage(canvas) {
  imageLandmarkerPromise ??= createPoseLandmarker('full', 'IMAGE').catch((err) => {
    imageLandmarkerPromise = null;
    throw err;
  });
  const landmarker = await imageLandmarkerPromise;
  return landmarker.detect(canvas);
}

/** Webcam + PoseLandmarker en modo video. */
export class CameraTracker {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.variant = null;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
  }

  get running() {
    return !!this.stream;
  }

  async setVariant(variant) {
    if (this.variant === variant && this.landmarker) return;
    const next = await createPoseLandmarker(variant, 'VIDEO');
    this.landmarker?.close();
    this.landmarker = next;
    this.variant = variant;
    this.lastVideoTime = -1;
  }

  async start(deviceId) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no permite usar la cámara (se necesita HTTPS o localhost).');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (err) {
      this.stop();
      const messages = {
        NotAllowedError: 'No se dio permiso para usar la cámara.',
        NotFoundError: 'No se encontró ninguna cámara.',
        NotReadableError: 'La cámara está siendo usada por otra aplicación.',
        OverconstrainedError: 'La cámara elegida no está disponible.',
      };
      throw messages[err?.name] ? new Error(messages[err.name]) : err;
    }
    this.lastVideoTime = -1;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Devuelve un resultado nuevo cuando la cámara entregó un cuadro nuevo; si no, null. */
  detect() {
    const v = this.video;
    if (!this.stream || !this.landmarker || v.readyState < 2 || v.videoWidth === 0) return null;
    if (v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    // Los timestamps tienen que ser estrictamente crecientes.
    const now = Math.max(performance.now(), this.lastTimestamp + 1);
    this.lastTimestamp = now;
    return this.landmarker.detectForVideo(v, now);
  }

  static async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }
}
