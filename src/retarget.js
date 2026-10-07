import * as THREE from 'three';
import { LM } from './landmarks.js';
import { SIDES, boneTipPosition } from './humanoid.js';

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const IDENTITY = new THREE.Quaternion();
const DEG = Math.PI / 180;
const VISIBILITY_THRESHOLD = 0.5;

// Pose relajada de los brazos (lado izquierdo; el derecho se refleja en X).
const RELAXED_UPPER_ARM = new THREE.Vector3(0.12, -1, 0.02).normalize();
const RELAXED_LOWER_ARM = new THREE.Vector3(0.06, -1, 0.3).normalize();

// Inclinación natural de la línea oreja→ojo cuando la cabeza mira al frente.
const DEFAULT_HEAD_PITCH = 12 * DEG;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Rotación cuya base es (primary, secondary⊥, primary × secondary⊥).
 * Comparando la base "objetivo" con la de reposo se obtiene la rotación del hueso.
 */
export function frameQuat(primary, secondary, out = new THREE.Quaternion()) {
  _a.copy(primary).normalize();
  _b.copy(secondary).addScaledVector(_a, -secondary.dot(_a));
  if (_b.lengthSq() < 1e-12) {
    _b.copy(Math.abs(_a.y) < 0.9 ? AXIS_Y : AXIS_X).addScaledVector(_a, -(Math.abs(_a.y) < 0.9 ? _a.y : _a.x));
  }
  _b.normalize();
  _c.crossVectors(_a, _b);
  _m.makeBasis(_a, _b, _c);
  return out.setFromRotationMatrix(_m);
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Limita el ángulo de `q` respecto de `base` (evita muñecas/tobillos imposibles). */
function clampRelative(base, q, maxAngle) {
  const rel = base.clone().invert().multiply(q);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
  if (angle > maxAngle) rel.slerp(IDENTITY, 1 - maxAngle / angle);
  return base.clone().multiply(rel);
}

const mid = (a, b) => new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
const sub = (a, b) => new THREE.Vector3().subVectors(a, b);

const LIMB_LANDMARKS = {
  leftArm: [LM.leftShoulder, LM.leftElbow, LM.leftWrist],
  rightArm: [LM.rightShoulder, LM.rightElbow, LM.rightWrist],
  leftLeg: [LM.leftHip, LM.leftKnee, LM.leftAnkle],
  rightLeg: [LM.rightHip, LM.rightKnee, LM.rightAnkle],
};
const HAND_LANDMARKS = {
  left: [LM.leftWrist, LM.leftPinky, LM.leftIndex],
  right: [LM.rightWrist, LM.rightPinky, LM.rightIndex],
};
const FOOT_LANDMARKS = {
  left: [LM.leftAnkle, LM.leftFootIndex],
  right: [LM.rightAnkle, LM.rightFootIndex],
};

/**
 * Traduce los 33 puntos 3D de MediaPipe a rotaciones de los huesos del modelo.
 *
 * Funciona con cualquier pose de reposo (T, A…): para cada hueso se mide su
 * dirección/base en reposo y se calcula la rotación mundial que la lleva a la
 * dirección/base observada en la cámara. Los codos y rodillas usan el plano
 * de flexión para resolver el giro del brazo/pierna.
 */
export class Retargeter {
  constructor(root, bones) {
    this.root = root;
    this.bones = bones;
    this.presence = {};
    this.headCorrection = new THREE.Quaternion().setFromAxisAngle(AXIS_X, DEFAULT_HEAD_PITCH);
    this.lastHeadMeasure = null;
    this.lastChest = new THREE.Quaternion();
    this.captureRest();
  }

  /** Lista de todos los huesos que el retargeting escribe. */
  drivenBones() {
    const b = this.bones;
    const list = [b.hips, ...b.spine, b.neck, b.head];
    for (const s of SIDES) {
      list.push(b[s + 'UpperArm'], b[s + 'LowerArm'], b[s + 'Hand'], b[s + 'UpperLeg'], b[s + 'LowerLeg'], b[s + 'Foot']);
    }
    return list.filter(Boolean);
  }

  captureRest() {
    const B = this.bones;
    this.root.updateMatrixWorld(true);
    const pos = (bone) => bone.getWorldPosition(new THREE.Vector3());

    this.restLocal = new Map();
    this.restWorld = new Map();
    for (const bone of this.drivenBones()) {
      this.restLocal.set(bone, bone.quaternion.clone());
      this.restWorld.set(bone, bone.getWorldQuaternion(new THREE.Quaternion()));
    }

    // Torso: base formada por la línea de caderas/hombros y el eje vertical del tronco.
    const hipL = B.leftUpperLeg && pos(B.leftUpperLeg);
    const hipR = B.rightUpperLeg && pos(B.rightUpperLeg);
    const shL = B.leftUpperArm && pos(B.leftUpperArm);
    const shR = B.rightUpperArm && pos(B.rightUpperArm);
    const hipMid = hipL && hipR ? mid(hipL, hipR) : pos(B.hips);
    const shMid = shL && shR ? mid(shL, shR) : B.neck ? pos(B.neck) : B.head ? pos(B.head) : null;
    const up = shMid ? sub(shMid, hipMid) : AXIS_Y.clone();
    const upHips = up.clone().normalize().add(AXIS_Y);
    this.rest = {
      hipsInv: frameQuat(hipL && hipR ? sub(hipL, hipR) : AXIS_X, upHips).invert(),
      chestInv: frameQuat(shL && shR ? sub(shL, shR) : AXIS_X, up).invert(),
    };

    // Brazos y piernas.
    for (const side of SIDES) {
      for (const [kind, upperK, lowerK, endK, bend] of [
        ['Arm', 'UpperArm', 'LowerArm', 'Hand', AXIS_Z],
        ['Leg', 'UpperLeg', 'LowerLeg', 'Foot', AXIS_Z.clone().negate()],
      ]) {
        const upper = B[side + upperK];
        const lower = B[side + lowerK];
        const end = B[side + endK];
        if (!upper || !lower || !end) continue;
        const d1 = sub(pos(lower), pos(upper)).normalize();
        const d2 = sub(pos(end), pos(lower)).normalize();
        const n1 = new THREE.Vector3().crossVectors(d1, bend);
        const n2 = new THREE.Vector3().crossVectors(d2, bend);
        this.rest[side + kind] = { d1, d2, n2, upperInv: frameQuat(d1, n1).invert() };
      }

      // Mano: dirección muñeca→dedos y normal de la palma (= eje del codo en reposo).
      const hand = B[side + 'Hand'];
      const arm = this.rest[side + 'Arm'];
      if (hand && arm) {
        const tip = boneTipPosition(hand) ?? pos(hand).addScaledVector(arm.d2, 0.1);
        const dir = sub(tip, pos(hand));
        if (dir.lengthSq() > 1e-10) this.rest[side + 'Hand'] = { inv: frameQuat(dir, arm.n2).invert() };
      }

      // Pie: dirección tobillo→punta.
      const foot = B[side + 'Foot'];
      if (foot && this.rest[side + 'Leg']) {
        const toes = B[side + 'Toes'] ? pos(B[side + 'Toes']) : boneTipPosition(foot);
        const dir = toes ? sub(toes, pos(foot)) : new THREE.Vector3(0, -0.4, 1);
        if (dir.lengthSq() > 1e-10) this.rest[side + 'Foot'] = { dir: dir.normalize() };
      }
    }

    // Altura de los pies respecto de la cadera (para mantenerlos en el piso).
    this.restFootDrop = this.footDrop();
  }

  resetPose() {
    for (const [bone, q] of this.restLocal) bone.quaternion.copy(q);
    for (const key of Object.keys(this.presence)) this.presence[key] = 0;
  }

  /** Distancia vertical entre la cadera y el punto más bajo de los pies. */
  footDrop() {
    const B = this.bones;
    const feet = [B.leftFoot, B.rightFoot, B.leftToes, B.rightToes].filter(Boolean);
    if (!B.hips || feet.length === 0) return null;
    this.root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const hipsY = B.hips.getWorldPosition(v).y;
    let minY = Infinity;
    for (const f of feet) minY = Math.min(minY, f.getWorldPosition(v).y);
    return hipsY - minY;
  }

  /** Cuánto hay que bajar el modelo para que los pies sigan en el piso (p. ej. al agacharse). */
  groundOffset() {
    const legs = Math.min(this.presence.leftLeg ?? 0, this.presence.rightLeg ?? 0);
    if (this.restFootDrop === null || legs < 0.01) return 0;
    return (this.footDrop() - this.restFootDrop) * legs;
  }

  /** Toma la pose actual de la cabeza como "mirando al frente". */
  calibrateHead() {
    if (!this.lastHeadMeasure) return false;
    this.headCorrection.copy(this.lastHeadMeasure).invert().multiply(this.lastChest);
    return true;
  }

  /**
   * @param points 33 THREE.Vector3 en espacio del avatar (o null si no hay persona)
   * @param visibility 33 valores 0..1
   * @param options { torso, head, arms, hands, legs }
   * @param dt segundos desde el último cuadro
   */
  update(points, visibility, options, dt) {
    const B = this.bones;
    if (!B.hips) return;
    const P = points;
    const vis = (...ids) => (P ? Math.min(...ids.map((i) => visibility[i])) : 0);
    const k = 1 - Math.exp(-Math.max(dt, 0) * 8);
    const presence = this.presence;
    const fade = (key, on) => {
      presence[key] = (presence[key] ?? 0) + ((on ? 1 : 0) - (presence[key] ?? 0)) * k;
      return presence[key];
    };
    const visible = (...ids) => vis(...ids) > VISIBILITY_THRESHOLD;

    // Memo de rotaciones mundiales del cuadro actual.
    this.memo = new Map();
    if (B.hips.parent) {
      B.hips.parent.updateWorldMatrix(true, false);
      this.memo.set(B.hips.parent, B.hips.parent.getWorldQuaternion(new THREE.Quaternion()));
    }

    // --- Torso -------------------------------------------------------------
    const pHips = fade('hips', options.torso && visible(LM.leftHip, LM.rightHip));
    const pChest = fade('chest', options.torso && visible(LM.leftShoulder, LM.rightShoulder));
    const qHips = new THREE.Quaternion();
    const qChest = new THREE.Quaternion();
    if (P) {
      const hipMid = mid(P[LM.leftHip], P[LM.rightHip]);
      const shMid = mid(P[LM.leftShoulder], P[LM.rightShoulder]);
      const up = sub(shMid, hipMid).normalize().lerp(AXIS_Y, 1 - pHips).normalize();
      const upHips = up.clone().add(AXIS_Y);
      const hipsT = frameQuat(sub(P[LM.leftHip], P[LM.rightHip]), upHips).multiply(this.rest.hipsInv);
      const chestT = frameQuat(sub(P[LM.leftShoulder], P[LM.rightShoulder]), up).multiply(this.rest.chestInv);
      qHips.slerp(hipsT, pHips);
      qChest.copy(qHips).slerp(chestT, pChest);
    }
    this.setWorld(B.hips, qHips);
    B.spine.forEach((bone, i) => this.setWorld(bone, qHips.clone().slerp(qChest, (i + 1) / B.spine.length)));
    this.lastChest.copy(qChest);

    // --- Cabeza ------------------------------------------------------------
    const pHead = fade('head', options.head && vis(LM.nose) > VISIBILITY_THRESHOLD &&
      Math.max(vis(LM.leftEar), vis(LM.rightEar)) > 0.3);
    const qHead = qChest.clone();
    if (P) {
      const earMid = mid(P[LM.leftEar], P[LM.rightEar]);
      const forward = sub(mid(P[LM.leftEye], P[LM.rightEye]), earMid);
      const across = sub(P[LM.leftEar], P[LM.rightEar]);
      const measured = frameQuat(across, new THREE.Vector3().crossVectors(forward, across));
      this.lastHeadMeasure = measured.clone();
      const headT = clampRelative(qChest, measured.multiply(this.headCorrection), 80 * DEG);
      qHead.slerp(headT, pHead);
    }
    if (B.neck) this.setWorld(B.neck, qChest.clone().slerp(qHead, 0.5));
    if (B.head) this.setWorld(B.head, qHead);

    // --- Brazos y manos ----------------------------------------------------
    for (const side of SIDES) {
      const [iS, iE, iW] = LIMB_LANDMARKS[side + 'Arm'];
      const pArm = fade(side + 'Arm', options.arms && visible(iS, iE, iW));
      const qLower = this.limb(side, 'Arm', qChest, pArm, P);
      const [hW, hP, hI] = HAND_LANDMARKS[side];
      const pHand = fade(side + 'Hand', options.arms && options.hands && visible(hW, hP, hI));
      const hand = B[side + 'Hand'];
      const rest = this.rest[side + 'Hand'];
      if (hand && rest && qLower) {
        const qHand = qLower.clone();
        if (P && pHand > 0.001) {
          const dir = sub(mid(P[hI], P[hP]), P[hW]);
          const normal = new THREE.Vector3().crossVectors(sub(P[hP], P[hW]), sub(P[hI], P[hW]));
          if (dir.lengthSq() > 1e-10 && normal.lengthSq() > 1e-12) {
            const target = clampRelative(qLower, frameQuat(dir, normal).multiply(rest.inv), 70 * DEG);
            qHand.slerp(target, pHand);
          }
        }
        this.setWorld(hand, qHand);
      }
    }

    // --- Piernas y pies ----------------------------------------------------
    for (const side of SIDES) {
      const [iH, iK, iA] = LIMB_LANDMARKS[side + 'Leg'];
      const pLeg = fade(side + 'Leg', options.legs && visible(iH, iK, iA));
      const qLower = this.limb(side, 'Leg', qHips, pLeg, P);
      const [fA, fT] = FOOT_LANDMARKS[side];
      const pFoot = fade(side + 'Foot', options.legs && visible(iK, fA, fT));
      const foot = B[side + 'Foot'];
      const rest = this.rest[side + 'Foot'];
      if (foot && rest && qLower) {
        const qFoot = qLower.clone();
        if (P && pFoot > 0.001) {
          const dir = sub(P[fT], P[fA]);
          if (dir.lengthSq() > 1e-10) {
            const from = rest.dir.clone().applyQuaternion(qLower);
            const swing = new THREE.Quaternion().setFromUnitVectors(from, dir.normalize()).multiply(qLower);
            qFoot.slerp(clampRelative(qLower, swing, 50 * DEG), pFoot);
          }
        }
        this.setWorld(foot, qFoot);
      }
    }
  }

  /** Resuelve un brazo o pierna (hueso superior + inferior). Devuelve la rotación del inferior. */
  limb(side, kind, qParent, presence, P) {
    const B = this.bones;
    const rest = this.rest[side + kind];
    const upper = B[side + (kind === 'Arm' ? 'UpperArm' : 'UpperLeg')];
    const lower = B[side + (kind === 'Arm' ? 'LowerArm' : 'LowerLeg')];
    if (!rest || !upper || !lower) return null;

    // Sin datos de la cámara: piernas en reposo (parado) y brazos relajados al costado del cuerpo.
    let qUpper = qParent.clone();
    let qLower = qParent.clone();
    if (kind === 'Arm') {
      const sign = side === 'left' ? 1 : -1;
      const d1 = RELAXED_UPPER_ARM.clone().setX(sign * RELAXED_UPPER_ARM.x).applyQuaternion(qParent);
      const d2 = RELAXED_LOWER_ARM.clone().setX(sign * RELAXED_LOWER_ARM.x).applyQuaternion(qParent);
      [qUpper, qLower] = this.solveLimb(rest, d1, d2);
    }
    if (P && presence > 0.001) {
      const [iA, iB, iC] = LIMB_LANDMARKS[side + kind];
      const [upperTarget, lowerTarget] = this.solveLimb(rest, sub(P[iB], P[iA]).normalize(), sub(P[iC], P[iB]).normalize());
      qUpper.slerp(upperTarget, presence);
      qLower.slerp(lowerTarget, presence);
    }
    this.setWorld(upper, qUpper);
    this.setWorld(lower, qLower);
    return qLower;
  }

  /** Rotaciones (respecto del reposo) que llevan el segmento superior a `d1` y el inferior a `d2`. */
  solveLimb(rest, d1, d2) {
    // Giro mínimo desde la pose de reposo…
    let upper = new THREE.Quaternion().setFromUnitVectors(rest.d1, d1);
    // …corregido con el plano de flexión del codo/rodilla cuando está doblado.
    const hingeAxis = new THREE.Vector3().crossVectors(d1, d2);
    const bendWeight = smoothstep(0.1, 0.35, hingeAxis.length());
    if (bendWeight > 0) {
      const hinge = frameQuat(d1, hingeAxis).multiply(rest.upperInv);
      upper = upper.slerp(hinge, bendWeight);
    }
    const from = rest.d2.clone().applyQuaternion(upper);
    const lower = new THREE.Quaternion().setFromUnitVectors(from, d2).multiply(upper);
    return [upper, lower];
  }

  worldQuat(obj) {
    if (!obj) return IDENTITY;
    let q = this.memo.get(obj);
    if (!q) {
      q = new THREE.Quaternion().multiplyQuaternions(this.worldQuat(obj.parent), obj.quaternion);
      this.memo.set(obj, q);
    }
    return q;
  }

  /** Aplica `delta` (rotación mundial respecto del reposo) al hueso. */
  setWorld(bone, delta) {
    const world = delta.clone().multiply(this.restWorld.get(bone));
    bone.quaternion.copy(this.worldQuat(bone.parent)).invert().multiply(world);
    this.memo.set(bone, world);
  }
}
