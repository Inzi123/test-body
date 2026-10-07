import * as THREE from 'three';

// Maniquí articulado de piezas rígidas, en pose T. Sirve como modelo por
// defecto y no necesita ningún archivo.
const JOINTS = {
  hips: [null, 0, 0.98, 0],
  spine: ['hips', 0, 1.1, 0],
  chest: ['spine', 0, 1.24, 0],
  neck: ['chest', 0, 1.45, 0],
  head: ['neck', 0, 1.54, 0],
  headEnd: ['head', 0, 1.76, 0],
  leftShoulder: ['chest', 0.04, 1.41, 0],
  leftUpperArm: ['leftShoulder', 0.18, 1.41, 0],
  leftLowerArm: ['leftUpperArm', 0.46, 1.41, 0],
  leftHand: ['leftLowerArm', 0.71, 1.41, 0],
  leftHandEnd: ['leftHand', 0.88, 1.41, 0],
  leftUpperLeg: ['hips', 0.1, 0.92, 0],
  leftLowerLeg: ['leftUpperLeg', 0.1, 0.51, 0],
  leftFoot: ['leftLowerLeg', 0.1, 0.09, 0],
  leftToes: ['leftFoot', 0.1, 0.025, 0.13],
  leftToesEnd: ['leftToes', 0.1, 0.025, 0.2],
};
for (const [name, [parent, x, y, z]] of Object.entries(JOINTS)) {
  if (name.startsWith('left')) {
    JOINTS[name.replace('left', 'right')] = [parent === 'chest' || parent === 'hips' ? parent : parent.replace('left', 'right'), -x, y, z];
  }
}

// Grosor de cada segmento (hueso → hijo).
const SEGMENT_RADIUS = {
  hips: 0.13, spine: 0.12, chest: 0.135, neck: 0.045, head: 0.0,
  Shoulder: 0.045, UpperArm: 0.048, LowerArm: 0.04, Hand: 0.035,
  UpperLeg: 0.07, LowerLeg: 0.05, Foot: 0.045, Toes: 0.035,
};

export function createMannequin() {
  const root = new THREE.Group();
  root.name = 'Maniquí';
  const bones = {};
  const world = {};
  for (const [name, [parent, x, y, z]] of Object.entries(JOINTS)) {
    const bone = new THREE.Bone();
    bone.name = name;
    world[name] = new THREE.Vector3(x, y, z);
    bones[name] = bone;
    const p = parent ? world[parent] : new THREE.Vector3();
    bone.position.set(x - p.x, y - p.y, z - p.z);
    (parent ? bones[parent] : root).add(bone);
  }

  const body = new THREE.MeshStandardMaterial({ color: 0xd9b48f, roughness: 0.55, metalness: 0.05 });
  const joint = new THREE.MeshStandardMaterial({ color: 0x3a3f4b, roughness: 0.4 });
  const accentL = new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.5 });
  const accentR = new THREE.MeshStandardMaterial({ color: 0xff7a59, roughness: 0.5 });
  const addMesh = (bone, mesh) => {
    mesh.castShadow = true;
    bone.add(mesh);
  };

  for (const [name, [parent]] of Object.entries(JOINTS)) {
    if (!parent || name === 'headEnd') continue;
    const parentBone = bones[parent];
    const from = world[parent];
    const to = world[name];
    const roleKey = parent.replace(/^(left|right)/, '');
    const radius = SEGMENT_RADIUS[roleKey] ?? 0.04;
    if (radius <= 0 || (parent === 'hips' && name !== 'spine') || (parent === 'chest' && name !== 'neck')) continue;
    const length = from.distanceTo(to);
    const material = parent.startsWith('left') ? accentL : parent.startsWith('right') ? accentR : body;
    const geo = new THREE.CapsuleGeometry(radius, Math.max(0.001, length - radius * 0.8), 6, 14);
    const mesh = new THREE.Mesh(geo, /UpperArm|UpperLeg|LowerArm|LowerLeg/.test(parent) ? material : body);
    const dir = new THREE.Vector3().subVectors(to, from);
    mesh.position.copy(dir).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    if (/Hand$/.test(parent)) mesh.scale.set(1.25, 1, 0.6);
    if (/Foot$/.test(parent)) mesh.scale.set(1.1, 1, 0.8);
    addMesh(parentBone, mesh);
  }

  // Pelvis, cabeza con nariz (para ver hacia dónde mira) y articulaciones.
  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), body);
  pelvis.scale.set(1.05, 0.7, 0.75);
  addMesh(bones.hips, pelvis);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 32, 24), body);
  head.position.set(0, 0.1, 0.01);
  head.scale.set(0.9, 1.1, 1);
  addMesh(bones.head, head);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 12), joint);
  nose.position.set(0, 0.09, 0.115);
  nose.rotation.x = Math.PI / 2;
  addMesh(bones.head, nose);
  for (const name of Object.keys(JOINTS)) {
    if (/End$|hips|spine|head|Shoulder/.test(name)) continue;
    const r = /Hand|Foot|Toes/.test(name) ? 0.035 : 0.052;
    addMesh(bones[name], new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), joint));
  }

  const boneMap = {
    hips: bones.hips,
    spine: [bones.spine, bones.chest],
    neck: bones.neck,
    head: bones.head,
  };
  for (const side of ['left', 'right']) {
    for (const role of ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes']) {
      boneMap[side + role] = bones[side + role];
    }
  }
  return { root, boneMap };
}
