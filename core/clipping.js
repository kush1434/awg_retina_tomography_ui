// ============================================================================
//  clipping.js — tri-planar slicing: clip-plane placement from a pane's
//  bounds, the visual slice quads / bounding cube / grid that follow them,
//  per-pane render-mode application (wireframe, clipping planes, sides) and
//  the stencil caps that fill a sliced coat's cross-section. Three-only: every
//  function takes the pane it works on and the live `view` state
//  ({ renderMode, clipState, solidFill }) that the Workbench owns.
// ============================================================================

import * as THREE from 'three';

const AXES = ['x', 'y', 'z'];

// The default clip state: no axis cut, every cut at the middle, normal side
// kept, slice quads shown. One fresh object per call — it is mutated live.
export function createClipState() {
  return {
    x: { on: false, pos: 0.5 },
    y: { on: false, pos: 0.5 },
    z: { on: false, pos: 0.5 },
    flip: false,
    showPlanes: true,
  };
}

// ---------------------------------------------------------------------------
//  Pure placement maths
// ---------------------------------------------------------------------------

// The clip plane for one axis: `pos` is the cut as a fraction of the bounds
// along `axis`; the plane keeps the side below the cut (normal pointing down
// the axis) unless `flip` keeps the side above it instead.
export function clipPlaneFor(axis, bounds, pos, flip) {
  const sign = flip ? 1 : -1;
  const cut = bounds.min[axis] + (bounds.max[axis] - bounds.min[axis]) * pos;
  const normal = new THREE.Vector3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
  const constant = sign === -1 ? cut : -cut;
  return { normal, constant, cut };
}

// Where the translucent slice quad for `axis` sits: centred on the bounds in
// the other two axes, spanning them, at the cut along its own.
export function sliceQuadPlacement(axis, bounds, pos) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const cut = bounds.min[axis] + (bounds.max[axis] - bounds.min[axis]) * pos;
  if (axis === 'x') return { position: new THREE.Vector3(cut, center.y, center.z), scale: new THREE.Vector3(size.z, size.y, 1) };
  if (axis === 'y') return { position: new THREE.Vector3(center.x, cut, center.z), scale: new THREE.Vector3(size.x, size.z, 1) };
  return { position: new THREE.Vector3(center.x, center.y, cut), scale: new THREE.Vector3(size.x, size.y, 1) };
}

// ---------------------------------------------------------------------------
//  Bounds → clip planes → render mode
// ---------------------------------------------------------------------------
export function updateBounds(pane, view) {
  if (!pane.root.children.length) return;
  pane.bounds.setFromObject(pane.root);
  const size = pane.bounds.getSize(new THREE.Vector3());
  const center = pane.bounds.getCenter(new THREE.Vector3());

  // bounding-cube wireframe
  pane.boxHelper.scale.copy(size); pane.boxHelper.position.copy(center);
  // grid floor at the base
  const gmax = Math.max(size.x, size.z) * 1.2 || 1;
  pane.grid.scale.set(gmax, 1, gmax);
  pane.grid.position.set(center.x, pane.bounds.min.y, center.z);

  updateClips(pane, view);
}

export function updateClips(pane, view) {
  if (pane.bounds.isEmpty()) return;
  const { clipState } = view;
  pane.activeClips = [];

  for (const ax of AXES) {
    const { normal, constant } = clipPlaneFor(ax, pane.bounds, clipState[ax].pos, clipState.flip);
    const plane = pane.clipPlanes[ax];
    plane.normal.copy(normal);
    plane.constant = constant;
    if (clipState[ax].on) pane.activeClips.push(plane);

    // position the visual quad at the cut
    const q = pane.sliceQuads[ax];
    const { position, scale } = sliceQuadPlacement(ax, pane.bounds, clipState[ax].pos);
    q.position.copy(position); q.scale.copy(scale);
    q.visible = clipState[ax].on;
  }
  applyRenderModeToPane(pane, view);
}

export function applyRenderModeToPane(pane, view) {
  const slicing = view.renderMode === 'slices';
  pane.sliceGroup.visible = slicing && view.clipState.showPlanes;
  pane.boxHelper.visible = slicing && !pane.bounds.isEmpty();
  pane.scene.traverse((o) => {
    if (!o.isMesh || o.userData.noClip) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.wireframe = view.renderMode === 'wireframe';
      m.clippingPlanes = slicing && pane.activeClips.length ? pane.activeClips : null;
      m.clipIntersection = false;
      // Anatomy shells manage their own side: translucent ones are split into a
      // BackSide and a FrontSide pass so they blend in the correct order.
      if (!m.userData?.anatomy) m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
  });
  buildCaps(pane, view);
}

// ---------------------------------------------------------------------------
//  Clip-plane capping
// ---------------------------------------------------------------------------
// A sliced mesh is a hollow open shell: at the cut you see straight through it,
// so adjacent coats read as separated by dark seams. For the (common) single
// active plane, fill each coat's cross-section with a stencil-masked colored
// quad so the cut renders as a solid, gap-free surface. Standard three.js
// stencil-cap technique (back faces increment, front faces decrement, cap drawn
// where the count != 0), one group per coat so each keeps its own colour.
const _capQuadGeom = new THREE.PlaneGeometry(1, 1);
export function stencilMat(side, op, plane) {
  const m = new THREE.MeshBasicMaterial();
  m.depthWrite = false; m.depthTest = false; m.colorWrite = false;
  m.side = side; m.clippingPlanes = [plane];
  m.stencilWrite = true; m.stencilFunc = THREE.AlwaysStencilFunc;
  m.stencilFail = op; m.stencilZFail = op; m.stencilZPass = op;
  return m;
}
export function clearCaps(pane) {
  const g = pane.capGroup;
  if (!g) return;
  for (const c of g.children) {
    const ms = Array.isArray(c.material) ? c.material : [c.material];
    ms.forEach((m) => m && m.dispose());
  }
  g.clear();
}

// The coats worth capping under `root`: every mesh that is actually showing
// (itself and every ancestor visible), has geometry and a material, is not a
// helper (`noClip`) and is not an anatomy back-face duplicate. Each entry
// carries the colour its cap will take.
export function collectCapCoats(root) {
  const coats = [];
  root.traverse((o) => {
    if (!o.isMesh || o.userData.noClip || !o.geometry || !o.material) return;
    if (o.userData.anatomyBackOf) return;   // duplicate of its parent's geometry
    let vis = o.visible, p = o.parent;
    while (vis && p) { vis = p.visible; p = p.parent; }
    if (!vis) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    coats.push({ mesh: o, color: mat.color });
  });
  return coats;
}

export function buildCaps(pane, view) {
  if (!pane.capsEnabled) return;
  clearCaps(pane);
  // Caps belong to Solid fill; with it off the slice view stays the original
  // uncapped coats. Cap only the single-plane case (the default); >1 plane uncapped.
  if (!view.solidFill || view.renderMode !== 'slices' || pane.activeClips.length !== 1) return;
  const plane = pane.activeClips[0];

  pane.root.updateWorldMatrix(true, true);
  const coats = collectCapCoats(pane.root);
  if (!coats.length) return;

  const size = pane.bounds.getSize(new THREE.Vector3());
  const capSize = (Math.max(size.x, size.y, size.z) || 1) * 2.4;
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal.clone().normalize());
  const pos = plane.normal.clone().multiplyScalar(-plane.constant);

  let order = 100;
  for (const { mesh, color } of coats) {
    for (const [side, op] of [[THREE.BackSide, THREE.IncrementWrapStencilOp], [THREE.FrontSide, THREE.DecrementWrapStencilOp]]) {
      const s = new THREE.Mesh(mesh.geometry, stencilMat(side, op, plane));
      s.matrixAutoUpdate = false; s.matrixWorldAutoUpdate = false;
      s.matrix.copy(mesh.matrixWorld); s.matrixWorld.copy(mesh.matrixWorld);
      s.renderOrder = order; s.frustumCulled = false; s.userData.noClip = true;
      pane.capGroup.add(s);
    }
    const capMat = new THREE.MeshBasicMaterial({ color: color.clone(), side: THREE.DoubleSide });
    capMat.stencilWrite = true; capMat.stencilRef = 0; capMat.stencilFunc = THREE.NotEqualStencilFunc;
    capMat.stencilFail = THREE.ReplaceStencilOp; capMat.stencilZFail = THREE.ReplaceStencilOp; capMat.stencilZPass = THREE.ReplaceStencilOp;
    capMat.polygonOffset = true; capMat.polygonOffsetFactor = -order; capMat.polygonOffsetUnits = -1;
    const cap = new THREE.Mesh(_capQuadGeom, capMat);
    cap.scale.set(capSize, capSize, 1);
    cap.quaternion.copy(quat);
    cap.position.copy(pos);
    cap.renderOrder = order + 1;
    cap.frustumCulled = false; cap.userData.noClip = true;
    // Only a real WebGLRenderer ever invokes this; the headless stub never does.
    cap.onAfterRender = (r) => r.clearStencil();
    pane.capGroup.add(cap);
    order += 3;
  }
}
