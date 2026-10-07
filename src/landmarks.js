import * as THREE from 'three';

// Índices de los 33 puntos de MediaPipe Pose.
export const LM = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
};

export const LANDMARK_COUNT = 33;

// Para el modo espejo: índice izquierdo <-> derecho.
const MIRROR_INDEX = (() => {
  const map = Array.from({ length: LANDMARK_COUNT }, (_, i) => i);
  const pairs = [
    [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16],
    [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
  ];
  for (const [a, b] of pairs) {
    map[a] = b;
    map[b] = a;
  }
  return map;
})();

/**
 * Convierte los landmarks "world" de MediaPipe (metros, origen en la cadera,
 * x a la derecha de la imagen, y hacia abajo, z alejándose de la cámara) al
 * espacio del avatar en Three.js (y arriba, z hacia el espectador; el avatar
 * mira a la cámara).
 *
 * Sin espejo el avatar reproduce lo que ve la webcam (como si otra persona te
 * mirara). Con espejo, además de reflejar X se intercambian izquierda/derecha,
 * así que tu mano derecha mueve la mano del avatar que está del mismo lado de
 * la pantalla, como en un espejo.
 */
export function toAvatarSpace(worldLandmarks, imageLandmarks, mirror, outPoints, outVisibility) {
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const src = mirror ? MIRROR_INDEX[i] : i;
    const w = worldLandmarks[src];
    outPoints[i].set(mirror ? -w.x : w.x, -w.y, -w.z);
    const img = imageLandmarks?.[src];
    outVisibility[i] = img?.visibility ?? w.visibility ?? 1;
  }
}

export function createPointArray() {
  return Array.from({ length: LANDMARK_COUNT }, () => new THREE.Vector3());
}
