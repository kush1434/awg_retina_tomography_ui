// ============================================================================
//  clipping.js — tri-planar slicing: clip-plane placement from a pane's
//  bounds, the visual slice quads / bounding cube / grid that follow them,
//  per-pane render-mode application (wireframe, clipping planes, sides) and
//  the stencil caps that fill a sliced coat's cross-section. Three-only. The
//  four pane-level entry points (updateBounds, updateClips,
//  applyRenderModeToPane, buildCaps) each take the pane they work on plus the
//  live `view` state ({ renderMode, clipState, solidFill }) that the Workbench
//  owns; the rest are standalone helpers — createClipState, the placement
//  maths (clipPlaneFor, sliceQuadPlacement) and the cap helpers (stencilMat,
//  clearCaps, collectCapCoats).
// ============================================================================

import * as THREE from 'three';

const AXES = ['x', 'y', 'z'];

/**
 * The default clip state: no axis cut, every cut at the middle, normal side
 * kept, slice quads shown.
 * @returns {{x: {on: boolean, pos: number}, y: {on: boolean, pos: number},
 *   z: {on: boolean, pos: number}, flip: boolean, showPlanes: boolean}}
 *   a fresh object per call, because it is mutated live rather than replaced:
 *   the Workbench hangs it off `view` and its setClipAxis / setClipPos write
 *   straight into it, so two workbenches must never share one.
 */
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

/**
 * The clip plane for one axis: `pos` is the cut as a fraction of the bounds
 * along `axis`; the plane keeps the side below the cut (normal pointing down
 * the axis) unless `flip` keeps the side above it instead.
 * @param {'x'|'y'|'z'} axis
 * @param {THREE.Box3} bounds
 * @param {number} pos 0..1 along `axis`
 * @param {boolean} [flip]
 * @returns {{normal: THREE.Vector3, constant: number, cut: number}} a plain
 *   record, not a THREE.Plane: `updateClips` copies it into the pane's live
 *   planes. `constant` already carries the sign convention; `cut` is the cut
 *   in world units, for callers that need the position rather than the plane.
 */
export function clipPlaneFor(axis, bounds, pos, flip) {
  const sign = flip ? 1 : -1;
  const cut = bounds.min[axis] + (bounds.max[axis] - bounds.min[axis]) * pos;
  const normal = new THREE.Vector3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
  const constant = sign === -1 ? cut : -cut;
  return { normal, constant, cut };
}

/**
 * Where the translucent slice quad for `axis` sits: centred on the bounds in
 * the other two axes, spanning them, at the cut along its own.
 * @param {'x'|'y'|'z'} axis
 * @param {THREE.Box3} bounds
 * @param {number} pos 0..1 along `axis`
 * @returns {{position: THREE.Vector3, scale: THREE.Vector3}} the scale is in
 *   the quad's *rotated* frame — the quads are turned once at creation, in
 *   createPane (core/pane.js) — which is why the x case scales by
 *   (size.z, size.y) and the y case by (size.x, size.z) rather than by the
 *   two axes the plane visibly spans.
 */
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

/**
 * Re-measures `pane.root` and re-places everything that hangs off its bounds:
 * mutates pane.bounds, the bounding-cube helper and the grid floor, then calls
 * updateClips — so the clip planes, slice quads and render mode are reapplied
 * too.
 * @param {object} pane
 * @param {{renderMode: string, clipState: object, solidFill: boolean}} view
 * @returns {void} Returns before measuring when pane.root has no children,
 *   which leaves the previous bounds standing: a pane whose content was just
 *   removed keeps stale bounds until something is added back.
 */
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

/**
 * Rewrites the pane's clip planes from `view.clipState` and moves the slice
 * quads to match. Each pane.clipPlanes[axis] is mutated in place, so every
 * material already holding a reference follows along; pane.activeClips is
 * rebuilt from the axes switched on, the quads are repositioned and shown or
 * hidden, and applyRenderModeToPane runs last.
 * @param {object} pane
 * @param {{renderMode: string, clipState: object, solidFill: boolean}} view
 * @returns {void} No-op on empty bounds — the planes, the quads *and* the
 *   render mode are all left as they were, since applyRenderModeToPane is
 *   only reached at the end.
 */
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

/**
 * Applies `view.renderMode` across the pane: shows or hides the slice group
 * and the bounding cube, then traverses the whole scene and rewrites every
 * mesh material it reaches — wireframe, clippingPlanes, clipIntersection, side
 * and needsUpdate. The name promises a mode switch; the blast radius is the
 * pane's entire scene graph. Meshes flagged `userData.noClip` are skipped, and
 * materials flagged `userData.anatomy` keep whatever `side` they set
 * themselves.
 *
 * Ends by calling buildCaps, so changing the render mode also rebuilds (or
 * tears down) the stencil caps.
 * @param {object} pane
 * @param {{renderMode: string, clipState: object, solidFill: boolean}} view
 * @returns {void}
 */
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

/**
 * One pass of the stencil count. Colour and depth writes are masked off, so
 * the material touches nothing but the stencil buffer.
 * @param {number} side THREE side constant — BackSide and FrontSide are run as
 *   a pair, with opposite ops.
 * @param {number} op THREE stencil op, used for fail, zfail and zpass alike.
 * @param {THREE.Plane} plane the single active clip plane the pass runs under.
 * @returns {THREE.MeshBasicMaterial} a fresh material; clearCaps disposes it.
 */
export function stencilMat(side, op, plane) {
  const m = new THREE.MeshBasicMaterial();
  m.depthWrite = false; m.depthTest = false; m.colorWrite = false;
  m.side = side; m.clippingPlanes = [plane];
  m.stencilWrite = true; m.stencilFunc = THREE.AlwaysStencilFunc;
  m.stencilFail = op; m.stencilZFail = op; m.stencilZPass = op;
  return m;
}

/**
 * Disposes every cap material and empties pane.capGroup; no-op when the pane
 * has no capGroup.
 *
 * Geometry is deliberately left alone: the stencil meshes borrow their
 * geometry from the live coat they cap, and the cap quads all share the
 * module-level `_capQuadGeom`, so disposing here would destroy geometry the
 * scene is still drawing.
 * @param {object} pane
 * @returns {void}
 */
export function clearCaps(pane) {
  const g = pane.capGroup;
  if (!g) return;
  for (const c of g.children) {
    const ms = Array.isArray(c.material) ? c.material : [c.material];
    ms.forEach((m) => m && m.dispose());
  }
  g.clear();
}

/**
 * The coats worth capping under `root`: every mesh that is actually showing
 * (itself and every ancestor visible), has geometry and a material, is not a
 * helper (`noClip`) and is not an anatomy back-face duplicate.
 * @param {THREE.Object3D} root
 * @returns {Array<{mesh: THREE.Mesh, color: THREE.Color}>} `color` is the
 *   mesh's *live* material colour, not a copy — buildCaps clones it before
 *   handing it to a cap material, and any other consumer must do the same or
 *   it will recolour the coat itself. Array materials contribute material[0].
 */
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

/**
 * Rebuilds the pane's stencil caps by the technique noted at the head of this
 * section: two stencil meshes and one coloured quad per visible coat, dropped
 * into pane.capGroup.
 *
 * The preconditions are checked in two stages, and the order matters. A pane
 * without `capsEnabled` is left completely untouched — today only the stl pane
 * is created with caps enabled (core/workbench.js), so every call against the
 * anatomy pane returns here. Otherwise the existing caps are cleared first,
 * and nothing is rebuilt unless `view.solidFill` is on, the render mode is
 * 'slices' and exactly one clip plane is active: caps belong to Solid fill,
 * with it off the slice view stays the original uncapped coats, and a cut by
 * more than one plane is left uncapped.
 * @param {object} pane
 * @param {{renderMode: string, clipState: object, solidFill: boolean}} view
 * @returns {void}
 */
export function buildCaps(pane, view) {
  if (!pane.capsEnabled) return;
  clearCaps(pane);
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
