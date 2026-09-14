// ============================================================================
//  framing.js — camera framing and group normalisation: the maths that puts a
//  bounding box in front of a PerspectiveCamera, and the normalise-to-target
//  rule that lets samples and the reference eye be stacked in one space.
//  Three-only — a pane here is just { camera, controls: { target, update },
//  defaultDist }; the view state and clip bounds stay with the caller.
// ============================================================================

import * as THREE from 'three';

/** @type {number} world-space size every sample group and the anatomy wrapper are normalised to. */
export const OVERLAY_TARGET = 100;

/**
 * Bounding box of a node's *content*, ignoring the node's own transform.
 *
 * It gets there by zeroing that transform, measuring, then restoring it
 * (matrixWorld included) — so it is not re-entrant and must not be called from
 * inside a render or a traversal of the same subtree.
 * @param {THREE.Object3D} node
 * @returns {THREE.Box3} the node's content with its own position/scale/
 *   rotation removed — possibly empty. Any *ancestor* transform still applies:
 *   the measurement reads matrixWorld, and the refresh here walks the node and
 *   its descendants, never its parents.
 */
export function localBox(node) {
  const p = node.position.clone(), s = node.scale.clone(), q = node.quaternion.clone();
  node.position.set(0, 0, 0); node.scale.set(1, 1, 1); node.quaternion.identity();
  node.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(node);
  node.position.copy(p); node.scale.copy(s); node.quaternion.copy(q);
  node.updateMatrixWorld(true);
  return box;
}

/**
 * Normalise a group to `target` (OVERLAY_TARGET), centre it at the origin, then
 * apply the group's offset so it can be stacked/separated.
 * @param {THREE.Object3D} node mutated: its scale and position are rewritten.
 * @param {{x: number, y: number, z: number}} [offset] in *fractions* of
 *   `target`, not world units — an x of 1 shifts the group by one full target
 *   size.
 * @param {number} [target=OVERLAY_TARGET]
 * @returns {void} No-op when the node has no content.
 */
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

/**
 * Distance at which a sphere of diameter `maxDim` fills the tighter field of
 * view of a camera with the given vertical `fov` and `aspect`.
 *
 * Honouring the *horizontal* FOV matters because the panes are tall and
 * narrow: fitting only the vertical FOV — as this did originally — crops
 * anything wider than it is tall, like the eye plus its optic nerve.
 * @param {{fov: number, aspect: number}} camera fov in DEGREES (three's
 *   PerspectiveCamera convention); a falsy aspect is treated as 1.
 * @param {number} maxDim
 * @param {number} [offset=1.45] normalised against 1.45, so 1.45 is a snug fit
 *   and larger values pull the camera back proportionally.
 * @returns {number}
 */
export function fitDistance({ fov, aspect }, maxDim, offset = 1.45) {
  const vFov = fov * (Math.PI / 180);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (aspect || 1));
  return ((maxDim / 2) / Math.sin(Math.min(vFov, hFov) / 2)) * (offset / 1.45);
}

/**
 * Frames `box` in the pane. Mutates pane.camera.near/far/position (and its
 * projection matrix), pane.controls.target and pane.defaultDist, then calls
 * controls.update() — so the controls are already in step when it returns.
 * @param {{camera: THREE.PerspectiveCamera, controls: {target: THREE.Vector3,
 *   update: Function}, defaultDist: number}} pane
 * @param {THREE.Box3} box
 * @param {number} [offset=1.45] as for fitDistance.
 * @param {THREE.Vector3|null} [dir=null] direction from the target to the
 *   camera; defaults to +Z.
 * @returns {void} No-op on an empty box — nothing is touched.
 */
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

/**
 * Frames `object`'s world-space box, so the caller can refresh its clip bounds
 * on the strength of the return value.
 * @param {object} pane as for fitBox.
 * @param {THREE.Object3D} object
 * @param {number} [offset=1.45]
 * @returns {boolean} true when the object was non-empty and the camera moved;
 *   false leaves the camera exactly as it was.
 */
export function fitToObject(pane, object, offset = 1.45) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return false;
  fitBox(pane, box, offset);
  return true;
}

/**
 * Union box of the visible, non-empty groups (the subject); when none is
 * showing, fall back to everything under `fallbackRoot` (the context).
 * @param {Iterable<THREE.Object3D>} groups any iterable — the LayerController
 *   passes a Map's .values(). Hidden and empty groups are skipped.
 * @param {THREE.Object3D} [fallbackRoot]
 * @returns {THREE.Box3} empty when no visible group has content and the
 *   fallback is absent or itself empty.
 */
export function unionBoxOfGroups(groups, fallbackRoot) {
  const box = new THREE.Box3();
  for (const g of groups) if (g.visible && g.children.length) box.expandByObject(g);
  if (box.isEmpty() && fallbackRoot) box.setFromObject(fallbackRoot);
  return box;
}
