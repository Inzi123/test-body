import * as THREE from 'three';
import { mapHumanoidByName, mapHumanoidFromVRM, hasSkeleton } from './humanoid.js';
import { frameQuat } from './retarget.js';
import { autoRig } from './autorig.js';

const TARGET_HEIGHT = 1.7;

/**
 * Deja el modelo listo para animar: con esqueleto humanoide, mirando a +Z,
 * parado sobre y=0 y de ~1,70 m de alto.
 * @returns {Promise<{container: THREE.Group, boneMap: object, vrm: any, autoRigged: boolean, rigMethod?: string}>}
 */
export async function prepareModel({ object, vrm }, { detect, onStatus } = {}) {
  const container = new THREE.Group();

  if (!vrm && !hasSkeleton(object)) {
    const rig = await autoRig(object, { detect, onStatus });
    container.add(rig.root);
    return { container, boneMap: rig.boneMap, vrm: null, autoRigged: true, rigMethod: rig.method };
  }

  container.add(object);
  const boneMap = vrm ? mapHumanoidFromVRM(vrm) : mapHumanoidByName(object);
  if (!boneMap.hips) {
    throw new Error('No encontré los huesos del esqueleto (cadera, brazos…). ¿Es un modelo humanoide?');
  }
  alignToFront(container, boneMap);
  fitToGround(container);
  object.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // los bounds del reposo no sirven al animar
    }
  });
  if (vrm?.springBoneManager) vrm.springBoneManager.reset();
  return { container, boneMap, vrm, autoRigged: false };
}

/** Rota el contenedor para que la izquierda del personaje sea +X y arriba +Y. */
function alignToFront(container, B) {
  container.updateMatrixWorld(true);
  const pos = (b) => b.getWorldPosition(new THREE.Vector3());
  let left = null;
  if (B.leftUpperArm && B.rightUpperArm) left = pos(B.leftUpperArm).sub(pos(B.rightUpperArm));
  else if (B.leftUpperLeg && B.rightUpperLeg) left = pos(B.leftUpperLeg).sub(pos(B.rightUpperLeg));
  const top = B.head ?? B.neck ?? B.spine.at(-1);
  if (!left || !top) return;
  const up = pos(top).sub(pos(B.hips));
  const q = frameQuat(left, up).invert();
  container.quaternion.premultiply(q);
  container.updateMatrixWorld(true);
}

function fitToGround(container) {
  container.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(container, true);
  const size = box.getSize(new THREE.Vector3());
  if (!(size.y > 0)) return;
  const s = TARGET_HEIGHT / size.y;
  container.scale.multiplyScalar(s);
  container.updateMatrixWorld(true);
  box.setFromObject(container, true);
  const center = box.getCenter(new THREE.Vector3());
  container.position.x -= center.x;
  container.position.z -= center.z;
  container.position.y -= box.min.y;
  container.updateMatrixWorld(true);
}
