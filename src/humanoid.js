import * as THREE from 'three';

// Huesos que usa el retargeting (nombres estilo VRM).
export const SIDES = ['left', 'right'];
export const LIMB_BONES = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'];
export const REPORT_BONES = [
  'hips', 'spine', 'neck', 'head',
  ...SIDES.flatMap((s) => LIMB_BONES.map((b) => s + b)),
];

// Alias por rol. Los nombres se normalizan antes de comparar (minúsculas, sin
// prefijos tipo "mixamorig:", "J_Bip_", "DEF-", y sin indicadores de lado).
const CENTER_ALIASES = {
  hips: ['hips', 'hip', 'pelvis'],
  neck: ['neck', 'neck01', 'neck1'],
  head: ['head'],
};
const SIDED_ALIASES = {
  Shoulder: ['shoulder', 'clavicle', 'collar', 'collarbone'],
  UpperArm: ['upperarm', 'arm', 'uparm'],
  LowerArm: ['lowerarm', 'forearm', 'lowarm', 'elbow'],
  Hand: ['hand', 'wrist'],
  UpperLeg: ['upperleg', 'upleg', 'thigh', 'hip'],
  LowerLeg: ['lowerleg', 'leg', 'calf', 'shin', 'knee', 'lowleg'],
  Foot: ['foot', 'ankle'],
  Toes: ['toes', 'toebase', 'toe', 'ball'],
};
const PREFIX_TOKENS = new Set(['j', 'bip', 'bip01', 'bip001', 'cc', 'base', 'def', 'c', 'mixamorig', 'armature']);

export function parseBoneName(name) {
  let s = name.replace(/^mixamorig\d*[:_]?/i, '');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const tokens = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let side = null;
  const rest = [];
  for (const t of tokens) {
    if (t === 'left' || t === 'l') side = 'left';
    else if (t === 'right' || t === 'r') side = 'right';
    else if (!PREFIX_TOKENS.has(t)) rest.push(t);
  }
  let base = rest.join('');
  if (!side) {
    const m = base.match(/^(left|right)(.+)$/) || base.match(/^(.+?)(left|right)$/);
    if (m) {
      side = m[1] === 'left' || m[2] === 'left' ? 'left' : 'right';
      base = m[1] === 'left' || m[1] === 'right' ? m[2] : m[1];
    }
  }
  return { side, base };
}

function isAncestor(ancestor, node) {
  for (let p = node?.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

function depthOf(node) {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) d++;
  return d;
}

/** Huesos candidatos: los que deforman mallas; si no hay, cualquier Bone. */
function collectCandidates(root) {
  const set = new Set();
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) o.skeleton.bones.forEach((b) => set.add(b));
  });
  if (set.size === 0) root.traverse((o) => o.isBone && set.add(o));
  return [...set];
}

export function hasSkeleton(root) {
  let found = false;
  root.traverse((o) => {
    if (o.isSkinnedMesh || o.isBone) found = true;
  });
  return found;
}

/** Busca los huesos humanoides por nombre en cualquier rig (Mixamo, Unreal, VRM, Blender, CC…). */
export function mapHumanoidByName(root) {
  const bones = {};
  const pick = (key, obj) => {
    if (!bones[key] || depthOf(obj) < depthOf(bones[key])) bones[key] = obj;
  };
  for (const obj of collectCandidates(root)) {
    const { side, base } = parseBoneName(obj.name || '');
    if (!base) continue;
    if (!side) {
      for (const [role, aliases] of Object.entries(CENTER_ALIASES)) if (aliases.includes(base)) pick(role, obj);
    } else {
      for (const [role, aliases] of Object.entries(SIDED_ALIASES)) if (aliases.includes(base)) pick(side + role, obj);
    }
  }
  return finalizeBoneMap(bones);
}

/** Usa el mapeo humanoide oficial de un VRM. */
export function mapHumanoidFromVRM(vrm) {
  const get = (n) => vrm.humanoid.getRawBoneNode(n) ?? undefined;
  const bones = { hips: get('hips'), neck: get('neck'), head: get('head') };
  for (const side of SIDES) for (const role of LIMB_BONES) bones[side + role] = get(side + role);
  return finalizeBoneMap(bones);
}

/** Corrige huecos/incoherencias del mapeo y calcula la cadena de la columna. */
export function finalizeBoneMap(bones) {
  for (const side of SIDES) {
    const chains = [
      ['Shoulder', 'UpperArm', 'LowerArm', 'Hand'],
      ['', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'],
    ];
    for (const [clav, upper, lower, end, toe] of chains) {
      const k = (r) => side + r;
      if (bones[k(end)] && !bones[k(lower)]) bones[k(lower)] = bones[k(end)].parent;
      if (bones[k(lower)] && !bones[k(upper)]) bones[k(upper)] = bones[k(lower)].parent;
      if (bones[k(lower)] && bones[k(upper)] && !isAncestor(bones[k(upper)], bones[k(lower)])) bones[k(lower)] = undefined;
      if (bones[k(end)] && bones[k(lower)] && !isAncestor(bones[k(lower)], bones[k(end)])) bones[k(end)] = undefined;
      if (toe && bones[k(toe)] && bones[k(end)] && !isAncestor(bones[k(end)], bones[k(toe)])) bones[k(toe)] = undefined;
      if (clav && bones[k(clav)] && (bones[k(clav)] === bones[k(upper)] || !isAncestor(bones[k(clav)], bones[k(upper)]))) {
        bones[k(clav)] = undefined;
      }
    }
  }
  if (!bones.hips && bones.leftUpperLeg) bones.hips = bones.leftUpperLeg.parent;
  if (bones.head && bones.neck && !isAncestor(bones.neck, bones.head)) bones.neck = undefined;

  // Columna: todos los huesos entre la cadera y el cuello (o la cabeza).
  bones.spine = [];
  const top = bones.neck ?? bones.head ?? bones.leftShoulder?.parent ?? bones.leftUpperArm?.parent;
  if (bones.hips && top && isAncestor(bones.hips, top)) {
    const chain = [];
    for (let p = bones.neck || bones.head ? top.parent : top; p && p !== bones.hips; p = p.parent) chain.unshift(p);
    bones.spine = chain;
  }
  return bones;
}

/** Lista legible de huesos encontrados/faltantes, para la interfaz. */
export function describeBoneMap(bones) {
  return REPORT_BONES.map((key) => {
    const value = key === 'spine' ? bones.spine : bones[key];
    const ok = Array.isArray(value) ? value.length > 0 : !!value;
    const name = Array.isArray(value) ? value.map((b) => b.name).join(', ') : value?.name;
    return { key, ok, name: name || '' };
  });
}

/** Posición de reposo de la "punta" de un hueso (promedio de sus hijos). */
export function boneTipPosition(bone, out = new THREE.Vector3()) {
  const children = bone.children.filter((c) => c.isBone || c.type === 'Object3D');
  if (children.length === 0) return null;
  out.set(0, 0, 0);
  const tmp = new THREE.Vector3();
  for (const c of children) out.add(c.getWorldPosition(tmp));
  return out.divideScalar(children.length);
}
