// ============================================================================
//  framing.js — camera framing and group normalisation: the maths that puts a
//  bounding box in front of a PerspectiveCamera, and the normalise-to-target
//  rule that lets samples and the reference eye be stacked in one space.
//  Three-only — a pane here is just { camera, controls: { target, update },
//  defaultDist }; the view state and clip bounds stay with the caller.
// ============================================================================

import * as THREE from 'three';

export const OVERLAY_TARGET = 100;                          // groups are normalised to this size

// Bounding box of a node's *content*, ignoring the node's own transform.
export function localBox(node) {
  const p = node.position.clone(), s = node.scale.clone(), q = node.quaternion.clone();
  node.position.set(0, 0, 0); node.scale.set(1, 1, 1); node.quaternion.identity();
  node.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(node);
  node.position.copy(p); node.scale.copy(s); node.quaternion.copy(q);
  node.updateMatrixWorld(true);
  return box;
}

// Normalise a group to `target` (OVERLAY_TARGET), centre it at the origin, then
// apply the group's offset (a fraction of the target size) so it can be
// stacked/separated.
export function normalizeGroup(node, offset = { x: 0, y: 0, z: 0 }, target = OVERLAY_TARGET) {
  const box = localBox(node);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const s = target / (Math.max(size.x, size.y, size.z) || 1);
  node.scale.setScalar(s);
  node.position.set(
    offset.x * target - s * c.x,
    offset.y * target - s * c.y,
    offset.z * target - s * c.z
  );
}

// ---------------------------------------------------------------------------
//  Camera framing
// ---------------------------------------------------------------------------

// Distance at which a sphere of diameter `maxDim` fills the tighter field of
// view of a camera with the given vertical `fov` (degrees) and `aspect`.
// Honouring the *horizontal* FOV matters because the panes are tall and
// narrow: fitting only the vertical FOV — as this did originally — crops
// anything wider than it is tall, like the eye plus its optic nerve.
// `offset` keeps its old meaning, 1.45 being a snug fit.
export function fitDistance({ fov, aspect }, maxDim, offset = 1.45) {
  const vFov = fov * (Math.PI / 180);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (aspect || 1));
  return ((maxDim / 2) / Math.sin(Math.min(vFov, hFov) / 2)) * (offset / 1.45);
}

export function fitBox(pane, box, offset = 1.45, dir = null) {
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  // Fit the model's enclosing sphere against whichever field of view is the
  // tighter one (see fitDistance).
  const dist = fitDistance(pane.camera, maxDim, offset);

  pane.camera.near = Math.max(maxDim / 1000, 0.001);
  pane.camera.far = maxDim * 1000;
  pane.camera.updateProjectionMatrix();
  pane.controls.target.copy(center);
  pane.camera.position.copy(center).add((dir ? dir.clone().normalize() : new THREE.Vector3(0, 0, 1)).multiplyScalar(dist));
  pane.controls.update();
  pane.defaultDist = dist;
}

// Frames `object` and returns true when it did, so the caller can refresh
// its clip bounds; false (and no camera change) when the object is empty.
export function fitToObject(pane, object, offset = 1.45) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return false;
  fitBox(pane, box, offset);
  return true;
}

// Union box of the visible, non-empty groups (the subject); when none is
// showing, fall back to everything under `fallbackRoot` (the context).
export function unionBoxOfGroups(groups, fallbackRoot) {
  const box = new THREE.Box3();
  for (const g of groups) if (g.visible && g.children.length) box.expandByObject(g);
  if (box.isEmpty() && fallbackRoot) box.setFromObject(fallbackRoot);
  return box;
}
