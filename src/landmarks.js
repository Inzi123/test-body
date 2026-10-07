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
/**
 * @param hiddenHands lados de la persona ('left'/'right') cuya mano el detector de
 *   manos dejó de ver de golpe (ver main.js): si caen sobre el torso, están detrás.
 */
export function toAvatarSpace(worldLandmarks, imageLandmarks, mirror, outPoints, outVisibility, outInFrame, hiddenHands) {
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const src = mirror ? MIRROR_INDEX[i] : i;
    const w = worldLandmarks[src];
    outPoints[i].set(mirror ? -w.x : w.x, -w.y, -w.z);
    const img = imageLandmarks?.[src];
    outVisibility[i] = img?.visibility ?? w.visibility ?? 1;
    // Un punto tapado (p. ej. la mano detrás de la espalda) sigue teniendo una
    // posición estimada útil; uno fuera del cuadro no.
    if (outInFrame) outInFrame[i] = img ? img.x > -0.05 && img.x < 1.05 && img.y > -0.05 && img.y < 1.05 : true;
  }
  if (imageLandmarks) pushOccludedBehindTorso(imageLandmarks, mirror, outPoints, outVisibility, hiddenHands);
}

// Codos, muñecas y puntos de la mano.
const OCCLUDABLE = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const HAND_POINTS = { left: [15, 17, 19, 21], right: [16, 18, 20, 22] };
const OCCLUDED_VISIBILITY = 0.35;
const BEHIND_TORSO = 0.12; // metros detrás del plano del torso

/** ¿El punto (x, y) cae dentro del cuadrilátero hombros-caderas (agrandado un poco)? */
function insideTorso(p, image) {
  const quad = [LM.leftShoulder, LM.rightShoulder, LM.rightHip, LM.leftHip].map((i) => image[i]);
  const cx = quad.reduce((s, q) => s + q.x, 0) / 4;
  const cy = quad.reduce((s, q) => s + q.y, 0) / 4;
  const grown = quad.map((q) => ({ x: cx + (q.x - cx) * 1.15, y: cy + (q.y - cy) * 1.1 }));
  let inside = false;
  for (let i = 0, j = grown.length - 1; i < grown.length; j = i++) {
    const a = grown[i];
    const b = grown[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Con una sola cámara el detector no sabe si una mano está delante o detrás del
 * cuerpo, y suele elegir "delante". Si cae sobre el torso en la imagen y no se ve
 * (según el detector de cuerpo, o porque el detector de manos la perdió), tiene
 * que estar detrás: se la manda detrás del plano del torso.
 */
function pushOccludedBehindTorso(image, mirror, points, visibility, hiddenHands) {
  const torso = [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip];
  const torsoZ = torso.reduce((s, i) => s + points[i].z, 0) / torso.length;
  for (const i of OCCLUDABLE) {
    const src = mirror ? MIRROR_INDEX[i] : i;
    const handLost = [...(hiddenHands ?? [])].some((side) => HAND_POINTS[side].includes(src));
    if ((visibility[i] >= OCCLUDED_VISIBILITY && !handLost) || !insideTorso(image[src], image)) continue;
    points[i].z = Math.min(points[i].z, torsoZ - BEHIND_TORSO);
  }
  // Con la muñeca detrás, el codo tampoco puede quedar delante del torso.
  for (const [wrist, elbow] of [[LM.leftWrist, LM.leftElbow], [LM.rightWrist, LM.rightElbow]]) {
    if (points[wrist].z <= torsoZ - BEHIND_TORSO) points[elbow].z = Math.min(points[elbow].z, torsoZ - BEHIND_TORSO / 2);
  }
}

export const HAND_LANDMARK_COUNT = 21;

/** Puntos 3D de una mano (HandLandmarker) al espacio del avatar. */
export function handToAvatarSpace(worldLandmarks, mirror, outPoints) {
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    const w = worldLandmarks[i];
    outPoints[i].set(mirror ? -w.x : w.x, -w.y, -w.z);
  }
}

/**
 * Decide qué mano detectada es la izquierda y cuál la derecha de la persona,
 * comparando cada muñeca con las muñecas del detector de cuerpo (más confiable
 * que la etiqueta "Left/Right" del detector de manos).
 * @returns {{left: number|null, right: number|null}} índices en el resultado de manos
 */
export function assignHands(handImageLandmarks, poseImageLandmarks) {
  const out = { left: null, right: null };
  if (!handImageLandmarks?.length || !poseImageLandmarks) return out;
  const pairs = [];
  for (const [h, hand] of handImageLandmarks.entries()) {
    for (const side of ['left', 'right']) {
      const wrist = poseImageLandmarks[side === 'left' ? LM.leftWrist : LM.rightWrist];
      pairs.push({ h, side, d: Math.hypot(hand[0].x - wrist.x, hand[0].y - wrist.y) });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const used = new Set();
  for (const { h, side, d } of pairs) {
    if (d > 0.15 || used.has(h) || out[side] !== null) continue;
    out[side] = h;
    used.add(h);
  }
  return out;
}

export function createPointArray(count = LANDMARK_COUNT) {
  return Array.from({ length: count }, () => new THREE.Vector3());
}
