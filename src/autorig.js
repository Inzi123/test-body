import * as THREE from 'three';
import { LM } from './landmarks.js';

// Auto-rig para mallas estáticas (OBJ, STL, GLB sin esqueleto…):
//  1. Normaliza la malla (eje Y arriba, mirando a +Z, 1,70 m de alto).
//  2. Encuentra las articulaciones renderizando el modelo de frente y
//     pasándole MediaPipe Pose a esa imagen (o, si falla, por proporciones).
//  3. Crea un esqueleto humanoide y calcula los pesos de piel de cada vértice.

const TARGET_HEIGHT = 1.7;
const SIDES = ['left', 'right'];

// Jerarquía del esqueleto generado: hueso -> padre.
const HIERARCHY = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  headTop: 'head',
};
for (const s of SIDES) {
  Object.assign(HIERARCHY, {
    [s + 'Shoulder']: 'chest',
    [s + 'UpperArm']: s + 'Shoulder',
    [s + 'LowerArm']: s + 'UpperArm',
    [s + 'Hand']: s + 'LowerArm',
    [s + 'HandEnd']: s + 'Hand',
    [s + 'UpperLeg']: 'hips',
    [s + 'LowerLeg']: s + 'UpperLeg',
    [s + 'Foot']: s + 'LowerLeg',
    [s + 'Toes']: s + 'Foot',
    [s + 'ToesEnd']: s + 'Toes',
  });
}

// Huesos que deforman la malla y el hijo que define su segmento.
const SEGMENTS = {
  hips: 'spine',
  spine: 'chest',
  chest: 'neck',
  neck: 'head',
  head: 'headTop',
};
for (const s of SIDES) {
  Object.assign(SEGMENTS, {
    [s + 'Shoulder']: s + 'UpperArm',
    [s + 'UpperArm']: s + 'LowerArm',
    [s + 'LowerArm']: s + 'Hand',
    [s + 'Hand']: s + 'HandEnd',
    [s + 'UpperLeg']: s + 'LowerLeg',
    [s + 'LowerLeg']: s + 'Foot',
    [s + 'Foot']: s + 'Toes',
    [s + 'Toes']: s + 'ToesEnd',
  });
}

// Radio aproximado de cada parte del cuerpo (fracción de la altura).
const RADIUS_PRIOR = {
  hips: 0.085, spine: 0.085, chest: 0.09, neck: 0.035, head: 0.06,
  Shoulder: 0.045, UpperArm: 0.032, LowerArm: 0.025, Hand: 0.02,
  UpperLeg: 0.05, LowerLeg: 0.033, Foot: 0.025, Toes: 0.015,
};
const roleOf = (name) => name.replace(/^(left|right)/, '');

// ---------------------------------------------------------------------------
// Preparación de la malla

function bakeMeshes(object) {
  object.updateMatrixWorld(true);
  const parts = [];
  object.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const geometry = o.geometry.clone();
    geometry.applyMatrix4(o.matrixWorld);
    geometry.deleteAttribute('skinIndex');
    geometry.deleteAttribute('skinWeight');
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    parts.push({ name: o.name, geometry, material: o.material });
  });
  return parts;
}

function partsBox(parts) {
  const box = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox);
  }
  return box;
}

function transformParts(parts, matrix) {
  for (const p of parts) {
    p.geometry.applyMatrix4(matrix);
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
  }
}

/** Y arriba, pies en y=0, centrado y escalado a ~1,70 m. */
function normalizeParts(parts) {
  let size = partsBox(parts).getSize(new THREE.Vector3());
  if (size.z > size.y * 1.3 && size.z >= size.x * 0.8) {
    transformParts(parts, new THREE.Matrix4().makeRotationX(-Math.PI / 2)); // modelo con Z arriba
  }
  const box = partsBox(parts);
  size = box.getSize(new THREE.Vector3());
  const scale = TARGET_HEIGHT / size.y;
  const center = box.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
  transformParts(parts, m);
}

function buildPointCloud(parts) {
  let count = 0;
  for (const p of parts) count += p.geometry.attributes.position.count;
  const points = new Float32Array(count * 3);
  let o = 0;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++, o += 3) {
      points[o] = pos.getX(i);
      points[o + 1] = pos.getY(i);
      points[o + 2] = pos.getZ(i);
    }
  }
  return { points, box: partsBox(parts) };
}

/** Centro en profundidad (z) de la malla alrededor del punto (x, y). */
function depthAt(cloud, x, y, radius) {
  const pts = cloud.points;
  for (let r = radius, tries = 0; tries < 4; r *= 2, tries++) {
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      if (Math.abs(pts[i] - x) < r && Math.abs(pts[i + 1] - y) < r) {
        const z = pts[i + 2];
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    if (minZ <= maxZ) return (minZ + maxZ) / 2;
  }
  return cloud.box.getCenter(new THREE.Vector3()).z;
}

/** Extensión del pie (talón/punta) bajo un tobillo. */
function footExtent(cloud, ankle, H) {
  const pts = cloud.points;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumX = 0;
  let n = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i + 1] < ankle.y + 0.01 * H && Math.abs(pts[i] - ankle.x) < 0.06 * H) {
      const z = pts[i + 2];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      sumX += pts[i];
      n++;
    }
  }
  if (!n) return null;
  return { heel: minZ, tip: maxZ, x: sumX / n };
}

function addFeet(joints, cloud, H) {
  for (const s of SIDES) {
    const ankle = joints[s + 'Foot'];
    const ext = footExtent(cloud, ankle, H);
    if (!ext) {
      joints[s + 'Toes'] = new THREE.Vector3(ankle.x, 0.02 * H, ankle.z + 0.08 * H);
      joints[s + 'ToesEnd'] = new THREE.Vector3(ankle.x, 0.015 * H, ankle.z + 0.12 * H);
      continue;
    }
    const len = ext.tip - ext.heel;
    ankle.z = ext.heel + len * 0.22;
    ankle.y = Math.max(ankle.y, 0.035 * H);
    joints[s + 'Toes'] = new THREE.Vector3(THREE.MathUtils.lerp(ankle.x, ext.x, 0.6), 0.018 * H, ext.heel + len * 0.74);
    joints[s + 'ToesEnd'] = new THREE.Vector3(ext.x, 0.015 * H, ext.tip);
  }
}

// ---------------------------------------------------------------------------
// Detección de articulaciones con MediaPipe sobre un render del modelo

const CLAY = new THREE.MeshStandardMaterial({ color: 0xc89f7f, roughness: 0.7 });

function renderFront(parts, { rotate180 = false, clay = false } = {}) {
  const box = partsBox(parts);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const halfH = size.y * 0.58;
  const halfW = Math.max(size.x * 0.6, size.y * 0.3);
  const width = 640;
  const height = Math.round((width * halfH) / halfW);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0xd9d9d9);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const group = new THREE.Group();
  for (const p of parts) group.add(new THREE.Mesh(p.geometry, clay ? CLAY : p.material));
  if (rotate180) {
    group.position.set(center.x * 2, 0, center.z * 2);
    group.rotation.y = Math.PI;
  }
  scene.add(group);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(center.x + 1, center.y + 2, center.z + 4);
  scene.add(sun);

  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 100);
  camera.position.set(center.x, center.y, center.z + 10);
  camera.lookAt(center.x, center.y, center.z);
  renderer.render(scene, camera);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(renderer.domElement, 0, 0);
  renderer.dispose();
  renderer.forceContextLoss();

  const toWorld = (lm) => new THREE.Vector3(center.x + (lm.x - 0.5) * 2 * halfW, center.y + (0.5 - lm.y) * 2 * halfH, 0);
  return { canvas, toWorld };
}

const BODY_POINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const FACE_POINTS = [0, 2, 5, 9, 10];

function scorePose(landmarks) {
  if (!landmarks) return -1;
  const mean = (ids) => ids.reduce((s, i) => s + (landmarks[i].visibility ?? 0), 0) / ids.length;
  const body = mean(BODY_POINTS);
  if (body < 0.4) return -1;
  // De frente, el hombro izquierdo de la persona aparece a la derecha de la imagen.
  const facing = landmarks[LM.leftShoulder].x > landmarks[LM.rightShoulder].x ? 0.5 : 0;
  return body + mean(FACE_POINTS) + facing;
}

async function estimateJointsWithPose(parts, detect, onStatus) {
  let best = null;
  for (const clay of [false, true]) {
    for (const rotate180 of [false, true]) {
      onStatus?.(`Buscando articulaciones${rotate180 ? ' (vista trasera)' : ''}…`);
      const view = renderFront(parts, { rotate180, clay });
      const result = await detect(view.canvas);
      const landmarks = result?.landmarks?.[0];
      const score = scorePose(landmarks);
      if (score > (best?.score ?? -1)) best = { score, landmarks, view, rotate180 };
    }
    if (best && best.score > 1.2) break;
  }
  if (!best || best.score < 0) return null;

  if (best.rotate180) {
    const box = partsBox(parts);
    const c = box.getCenter(new THREE.Vector3());
    const m = new THREE.Matrix4()
      .makeTranslation(c.x, 0, c.z)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
    transformParts(parts, m);
  }
  const cloud = buildPointCloud(parts);
  const H = cloud.box.max.y - cloud.box.min.y;
  const lm = best.landmarks;
  const P = (i) => best.view.toWorld(lm[i]);
  const withDepth = (v, r = 0.025) => {
    v.z = depthAt(cloud, v.x, v.y, r * H);
    return v;
  };
  // Izquierda = +X (el modelo mira a +Z). Ordenamos cada par por X por si el detector se confunde.
  const pair = (l, r) => {
    const a = P(l);
    const b = P(r);
    return a.x >= b.x ? [a, b] : [b, a];
  };
  const [shL, shR] = pair(LM.leftShoulder, LM.rightShoulder);
  const [elL, elR] = pair(LM.leftElbow, LM.rightElbow);
  const [wrL, wrR] = pair(LM.leftWrist, LM.rightWrist);
  const [inL, inR] = pair(LM.leftIndex, LM.rightIndex);
  const [piL, piR] = pair(LM.leftPinky, LM.rightPinky);
  const [hiL, hiR] = pair(LM.leftHip, LM.rightHip);
  const [knL, knR] = pair(LM.leftKnee, LM.rightKnee);
  const [anL, anR] = pair(LM.leftAnkle, LM.rightAnkle);
  const mouth = P(LM.mouthLeft).add(P(LM.mouthRight)).multiplyScalar(0.5);

  const centerX = (hiL.x + hiR.x + shL.x + shR.x) / 4;
  const hipsY = (hiL.y + hiR.y) / 2 + 0.02 * H;
  const neckY = (shL.y + shR.y) / 2 + 0.015 * H;
  const headY = Math.max(mouth.y, neckY + 0.035 * H);
  const joints = {
    hips: withDepth(new THREE.Vector3(centerX, hipsY, 0)),
    spine: withDepth(new THREE.Vector3(centerX, THREE.MathUtils.lerp(hipsY, neckY, 0.33), 0)),
    chest: withDepth(new THREE.Vector3(centerX, THREE.MathUtils.lerp(hipsY, neckY, 0.66), 0)),
    neck: withDepth(new THREE.Vector3(centerX, neckY, 0)),
    head: withDepth(new THREE.Vector3(centerX, headY, 0)),
  };
  joints.headTop = new THREE.Vector3(centerX, cloud.box.max.y, joints.head.z);

  const sides = {
    left: [shL, elL, wrL, inL, piL, hiL, knL, anL],
    right: [shR, elR, wrR, inR, piR, hiR, knR, anR],
  };
  for (const s of SIDES) {
    const [sh, el, wr, ix, pk, hi, kn, an] = sides[s];
    joints[s + 'UpperArm'] = withDepth(sh);
    joints[s + 'Shoulder'] = joints.neck.clone().lerp(joints[s + 'UpperArm'], 0.2);
    joints[s + 'LowerArm'] = withDepth(el);
    joints[s + 'Hand'] = withDepth(wr, 0.02);
    joints[s + 'HandEnd'] = withDepth(ix.add(pk).multiplyScalar(0.5), 0.02);
    joints[s + 'UpperLeg'] = withDepth(hi);
    joints[s + 'LowerLeg'] = withDepth(kn);
    joints[s + 'Foot'] = an;
  }
  addFeet(joints, cloud, H);
  return { joints, cloud };
}

// ---------------------------------------------------------------------------
// Estimación por proporciones (si MediaPipe no está disponible o falla)

function sliceCentroidX(cloud, y, band, filter) {
  const pts = cloud.points;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (Math.abs(pts[i + 1] - y) < band && filter(pts[i])) {
      sum += pts[i];
      n++;
    }
  }
  return n ? sum / n : null;
}

function torsoHalfWidth(cloud, y, band, cx) {
  const xs = [];
  const pts = cloud.points;
  for (let i = 0; i < pts.length; i += 3) if (Math.abs(pts[i + 1] - y) < band) xs.push(pts[i]);
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  // Intervalos separados por huecos (brazos separados del torso).
  const gap = band * 2;
  let start = xs[0];
  let prev = xs[0];
  for (const x of xs.slice(1).concat(Infinity)) {
    if (x - prev > gap) {
      if (start <= cx && prev >= cx) return Math.min(cx - start, prev - cx);
      start = x;
    }
    prev = x;
  }
  return null;
}

function estimateJointsHeuristic(cloud) {
  const box = cloud.box;
  const H = box.max.y - box.min.y;
  const y0 = box.min.y;
  const cx = (box.min.x + box.max.x) / 2;
  const at = (f) => y0 + f * H;
  const band = 0.012 * H;
  const point = (x, f) => new THREE.Vector3(x, at(f), depthAt(cloud, x, at(f), 0.025 * H));

  const joints = {
    hips: point(cx, 0.53),
    spine: point(cx, 0.62),
    chest: point(cx, 0.72),
    neck: point(cx, 0.835),
    head: point(cx, 0.9),
  };
  joints.headTop = new THREE.Vector3(cx, box.max.y, joints.head.z);
  // Ancho del pecho: en pose A los brazos tocan el torso en algunas alturas,
  // así que se descartan los cortes demasiado anchos (torso + brazos).
  let half = 0;
  for (let f = 0.6; f <= 0.78; f += 0.02) {
    const h = torsoHalfWidth(cloud, at(f), band, cx);
    if (h && h < 0.13 * H) half = Math.max(half, h);
  }
  half = Math.max(half || 0.09 * H, 0.075 * H);

  for (const s of SIDES) {
    const sign = s === 'left' ? 1 : -1;
    const shoulder = point(cx + sign * half * 1.08, 0.81);
    // Punta de los dedos: el vértice más alejado lateralmente a la altura de los brazos.
    let tip = null;
    const pts = cloud.points;
    for (let i = 0; i < pts.length; i += 3) {
      const y = pts[i + 1];
      if (y < at(0.3) || y > at(0.88)) continue;
      if (!tip || sign * pts[i] > sign * tip.x) tip = new THREE.Vector3(pts[i], y, pts[i + 2]);
    }
    const dir = tip.clone().sub(shoulder);
    const len = dir.length();
    dir.normalize();
    const along = (f) => {
      const p = shoulder.clone().addScaledVector(dir, len * f);
      p.z = depthAt(cloud, p.x, p.y, 0.02 * H);
      return p;
    };
    joints[s + 'UpperArm'] = shoulder;
    joints[s + 'Shoulder'] = joints.neck.clone().lerp(shoulder, 0.2);
    joints[s + 'LowerArm'] = along(0.42);
    joints[s + 'Hand'] = along(0.77);
    joints[s + 'HandEnd'] = along(0.88);

    const side = (x) => sign * (x - cx) > 0.01 * H;
    const legX = (f) => sliceCentroidX(cloud, at(f), band, side) ?? cx + sign * 0.09 * H;
    joints[s + 'UpperLeg'] = point(legX(0.45), 0.5);
    joints[s + 'LowerLeg'] = point(legX(0.285), 0.285);
    joints[s + 'Foot'] = point(legX(0.06), 0.045);
  }
  addFeet(joints, cloud, H);
  return joints;
}

function jointsLookValid(j, H) {
  const len = (a, b) => j[a].distanceTo(j[b]) / H;
  for (const s of SIDES) {
    if (len(s + 'UpperArm', s + 'LowerArm') < 0.08 || len(s + 'LowerArm', s + 'Hand') < 0.07) return false;
    if (len(s + 'UpperLeg', s + 'LowerLeg') < 0.12 || len(s + 'LowerLeg', s + 'Foot') < 0.12) return false;
    if (j[s + 'LowerLeg'].y >= j[s + 'UpperLeg'].y || j[s + 'Foot'].y >= j[s + 'LowerLeg'].y) return false;
  }
  return j.neck.y > j.hips.y && j.head.y > j.neck.y;
}

// ---------------------------------------------------------------------------
// Esqueleto y pesos de piel

function buildSkeleton(joints) {
  const bones = {};
  for (const [name, parent] of Object.entries(HIERARCHY)) {
    const bone = new THREE.Bone();
    bone.name = name;
    const p = parent ? joints[parent] : new THREE.Vector3();
    bone.position.subVectors(joints[name], p);
    bones[name] = bone;
    if (parent) bones[parent].add(bone);
  }
  return bones;
}

function makeSegments(joints, H) {
  const names = Object.keys(SEGMENTS);
  const index = new Map(names.map((n, i) => [n, i]));
  const fwd = new THREE.Vector3(0, 0, 1);
  const segs = names.map((name) => {
    const a = joints[name];
    let b = joints[SEGMENTS[name]];
    if (/Hand$/.test(name)) b = a.clone().lerp(b, 1.7); // cubrir los dedos
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    return {
      name,
      a,
      d,
      len2: Math.max(d.lengthSq(), 1e-12),
      dir: d.clone().normalize(),
      radius: RADIUS_PRIOR[roleOf(name)] * H,
      parent: index.get(HIERARCHY[name]) ?? -1,
      children: [],
      // Plano de mezcla con el padre (en la articulación de inicio).
      jointPoint: a.clone(),
      jointNormal: d.clone().normalize(),
      blend: THREE.MathUtils.clamp(0.2 * len, 0.02 * H, 0.05 * H),
    };
  });
  for (const [i, s] of segs.entries()) if (s.parent >= 0) segs[s.parent].children.push(i);
  // Cabeza/cuello: plano inclinado (más bajo adelante, bajo el mentón; más alto atrás, en la nuca).
  const head = segs[index.get('head')];
  head.jointPoint.y -= 0.012 * H;
  head.jointNormal.addScaledVector(fwd, 0.4).normalize();
  head.blend = 0.022 * H;
  return { segs, index };
}

function segDistance2(s, x, y, z) {
  const px = x - s.a.x;
  const py = y - s.a.y;
  const pz = z - s.a.z;
  let t = (px * s.d.x + py * s.d.y + pz * s.d.z) / s.len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - s.d.x * t;
  const dy = py - s.d.y * t;
  const dz = pz - s.d.z * t;
  return dx * dx + dy * dy + dz * dz;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Qué huesos pueden influir en un vértice (evita que el brazo "agarre" el costado del torso, etc.). */
function makeAllowed(segs, index, joints, H) {
  const allowed = segs.map(() => () => true);
  for (const s of SIDES) {
    const sign = s === 'left' ? 1 : -1;
    const shoulderX = joints[s + 'UpperArm'].x;
    const hipY = joints[s + 'UpperLeg'].y;
    for (const r of ['UpperArm', 'LowerArm', 'Hand']) {
      allowed[index.get(s + r)] = (x) => sign * (x - shoulderX) > -0.015 * H;
    }
    for (const r of ['UpperLeg', 'LowerLeg', 'Foot', 'Toes']) {
      allowed[index.get(s + r)] = (x, y) => y < hipY + 0.04 * H && sign * x > -0.02 * H;
    }
  }
  return allowed;
}

function nearestSegment(segs, allowed, x, y, z) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < segs.length; i++) {
    if (!allowed[i](x, y, z)) continue;
    const d = Math.sqrt(segDistance2(segs[i], x, y, z)) / segs[i].radius;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Pesos (densos, uno por hueso) de un punto ya asignado a un segmento. */
function blendWeights(segs, i, x, y, z, out) {
  out.fill(0);
  out[i] = 1;
  const s = segs[i];
  const side = (seg) =>
    (x - seg.jointPoint.x) * seg.jointNormal.x + (y - seg.jointPoint.y) * seg.jointNormal.y + (z - seg.jointPoint.z) * seg.jointNormal.z;
  if (s.parent >= 0) {
    const t = smoothstep(-s.blend, s.blend, side(s));
    out[s.parent] = 1 - t;
    out[i] = t;
  }
  if (s.children.length) {
    let c = s.children[0];
    if (s.children.length > 1) {
      let bestD = Infinity;
      for (const ci of s.children) {
        const d = segDistance2(segs[ci], x, y, z) / (segs[ci].radius * segs[ci].radius);
        if (d < bestD) {
          bestD = d;
          c = ci;
        }
      }
    }
    const t = smoothstep(-segs[c].blend, segs[c].blend, side(segs[c]));
    out[c] += out[i] * t;
    out[i] *= 1 - t;
  }
}

/** Une vértices duplicados (misma posición) para poder recorrer la malla. */
function weld(geometry) {
  const pos = geometry.attributes.position;
  const map = new Map();
  const remap = new Uint32Array(pos.count);
  const unique = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e5)}_${Math.round(pos.getY(i) * 1e5)}_${Math.round(pos.getZ(i) * 1e5)}`;
    let u = map.get(key);
    if (u === undefined) {
      u = unique.length / 3;
      map.set(key, u);
      unique.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    remap[i] = u;
  }
  const count = unique.length / 3;
  const neighbors = Array.from({ length: count }, () => []);
  const idx = geometry.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = remap[idx ? idx.getX(t * 3) : t * 3];
    const b = remap[idx ? idx.getX(t * 3 + 1) : t * 3 + 1];
    const c = remap[idx ? idx.getX(t * 3 + 2) : t * 3 + 2];
    neighbors[a].push(b, c);
    neighbors[b].push(a, c);
    neighbors[c].push(a, b);
  }
  return { positions: unique, count, remap, neighbors };
}

function skinGeometry(part, segs, allowed, boneIndexOfSeg, H) {
  const geometry = part.geometry;
  const nb = segs.length;
  const { positions, count, remap, neighbors } = weld(geometry);
  let weights = new Float32Array(count * nb);
  const tmp = new Float32Array(nb);

  const box = geometry.boundingBox ?? geometry.computeBoundingBox() ?? geometry.boundingBox;
  const small = box.getSize(new THREE.Vector3()).length() < 0.15 * H;
  if (small) {
    // Piezas chicas (ojos, dientes…): rígidas al hueso dominante en su centro.
    const c = box.getCenter(new THREE.Vector3());
    const s = nearestSegment(segs, allowed, c.x, c.y, c.z);
    blendWeights(segs, s, c.x, c.y, c.z, tmp);
    const bone = tmp.indexOf(Math.max(...tmp));
    for (let u = 0; u < count; u++) weights[u * nb + bone] = 1;
  } else {
    for (let u = 0; u < count; u++) {
      const x = positions[u * 3];
      const y = positions[u * 3 + 1];
      const z = positions[u * 3 + 2];
      const s = nearestSegment(segs, allowed, x, y, z);
      blendWeights(segs, s, x, y, z, tmp);
      weights.set(tmp, u * nb);
    }
    // Suavizado de pesos siguiendo la superficie (transiciones más naturales).
    let next = new Float32Array(weights.length);
    for (let iter = 0; iter < 3; iter++) {
      for (let u = 0; u < count; u++) {
        const nbs = neighbors[u];
        const o = u * nb;
        if (!nbs.length) {
          for (let k = 0; k < nb; k++) next[o + k] = weights[o + k];
          continue;
        }
        const inv = 0.5 / nbs.length;
        for (let k = 0; k < nb; k++) next[o + k] = weights[o + k] * 0.5;
        for (const v of nbs) {
          const ov = v * nb;
          for (let k = 0; k < nb; k++) next[o + k] += weights[ov + k] * inv;
        }
      }
      [weights, next] = [next, weights];
    }
  }

  // Los 4 huesos con más peso por vértice.
  const n = geometry.attributes.position.count;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const top = new Int32Array(4);
  for (let i = 0; i < n; i++) {
    const o = remap[i] * nb;
    top.fill(-1);
    for (let k = 0; k < nb; k++) {
      const w = weights[o + k];
      if (w <= 0) continue;
      for (let j = 0; j < 4; j++) {
        if (top[j] < 0 || w > weights[o + top[j]]) {
          for (let m = 3; m > j; m--) top[m] = top[m - 1];
          top[j] = k;
          break;
        }
      }
    }
    let sum = 0;
    for (let j = 0; j < 4; j++) if (top[j] >= 0) sum += weights[o + top[j]];
    for (let j = 0; j < 4; j++) {
      if (top[j] < 0 || sum <= 0) continue;
      skinIndex[i * 4 + j] = boneIndexOfSeg[top[j]];
      skinWeight[i * 4 + j] = weights[o + top[j]] / sum;
    }
    if (sum <= 0) {
      skinIndex[i * 4] = boneIndexOfSeg[0];
      skinWeight[i * 4] = 1;
    }
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
}

/** Ajusta el radio de cada hueso al grosor real de la malla (mediana de distancias). */
function refineRadii(segs, allowed, cloud) {
  const dists = segs.map(() => []);
  const pts = cloud.points;
  const step = Math.max(3, Math.floor(pts.length / 3 / 40000) * 3);
  for (let i = 0; i < pts.length; i += step) {
    const s = nearestSegment(segs, allowed, pts[i], pts[i + 1], pts[i + 2]);
    if (s >= 0) dists[s].push(Math.sqrt(segDistance2(segs[s], pts[i], pts[i + 1], pts[i + 2])));
  }
  for (const [i, list] of dists.entries()) {
    if (list.length < 20) continue;
    list.sort((a, b) => a - b);
    const median = list[Math.floor(list.length / 2)];
    segs[i].radius = THREE.MathUtils.clamp(median, segs[i].radius * 0.5, segs[i].radius * 2);
  }
}

// ---------------------------------------------------------------------------

/**
 * @param object malla(s) sin esqueleto
 * @param options.detect función (canvas) => Promise<PoseLandmarkerResult> (opcional)
 * @param options.onStatus callback de progreso
 */
export async function autoRig(object, { detect, onStatus } = {}) {
  onStatus?.('Preparando la malla…');
  const parts = bakeMeshes(object);
  if (!parts.length) throw new Error('El archivo no contiene mallas.');
  normalizeParts(parts);

  let joints = null;
  let cloud = null;
  let method = 'proporciones';
  if (detect) {
    try {
      const found = await estimateJointsWithPose(parts, detect, onStatus);
      if (found && jointsLookValid(found.joints, TARGET_HEIGHT)) {
        ({ joints, cloud } = found);
        method = 'IA (MediaPipe)';
      }
    } catch (err) {
      console.warn('No se pudo detectar la pose del modelo, uso proporciones.', err);
    }
  }
  if (!joints) {
    cloud = buildPointCloud(parts);
    joints = estimateJointsHeuristic(cloud);
  }

  onStatus?.('Calculando pesos de piel…');
  await new Promise((r) => setTimeout(r, 0)); // dejar que la UI muestre el estado
  const H = TARGET_HEIGHT;
  const bones = buildSkeleton(joints);
  const boneList = Object.keys(HIERARCHY).map((n) => bones[n]);
  const { segs, index } = makeSegments(joints, H);
  const allowed = makeAllowed(segs, index, joints, H);
  refineRadii(segs, allowed, cloud);
  const boneIndexOfSeg = segs.map((s) => boneList.indexOf(bones[s.name]));

  const root = new THREE.Group();
  root.name = 'AutoRig';
  root.add(bones.hips);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);
  for (const part of parts) {
    skinGeometry(part, segs, allowed, boneIndexOfSeg, H);
    const mesh = new THREE.SkinnedMesh(part.geometry, part.material);
    mesh.name = part.name;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    root.add(mesh);
    mesh.bind(skeleton);
  }

  const boneMap = {
    hips: bones.hips,
    spine: [bones.spine, bones.chest],
    neck: bones.neck,
    head: bones.head,
  };
  for (const s of SIDES) {
    for (const r of ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes']) {
      boneMap[s + r] = bones[s + r];
    }
  }
  return { root, boneMap, joints, method };
}
