// ============================================================================
//  Tests for core/clipping.js — clip-plane placement from a pane's bounds
//  (normal/constant/cut per axis and flip), slice-quad placement, the bounds
//  → clips → render-mode chain, per-material render-mode rules, the stencil
//  cap gating and structure (render orders, stencil ops, polygon offset, quad
//  pose) and cap disposal. The pane here mirrors the slice helpers viewer.js's
//  createPane builds; only the renderer and controls are absent.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createClipState, clipPlaneFor, sliceQuadPlacement, collectCapCoats,
  updateBounds, updateClips, applyRenderModeToPane, stencilMat, clearCaps, buildCaps,
} from '../../core/clipping.js';
import { namedBoxGroup } from '../helpers/fixtures.js';

function near(a, b, msg) { assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`); }

// The slice-helper half of viewer.js's createPane (no renderer, no controls).
function fakePane({ capsEnabled = false } = {}) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const clipPlanes = {
    x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    y: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    z: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  };
  const sliceGroup = new THREE.Group(); sliceGroup.visible = false; scene.add(sliceGroup);
  const sliceQuads = {};
  for (const ax of ['x', 'y', 'z']) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    q.userData.noClip = true;
    sliceQuads[ax] = q; sliceGroup.add(q);
  }
  const boxHelper = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial());
  boxHelper.userData.noClip = true; boxHelper.visible = false; scene.add(boxHelper);
  const grid = new THREE.GridHelper(1, 20);
  grid.visible = false; grid.userData.noClip = true; scene.add(grid);
  const capGroup = new THREE.Group(); capGroup.userData.noClip = true; scene.add(capGroup);
  return {
    scene, root, clipPlanes, activeClips: [], sliceGroup, sliceQuads, boxHelper, grid, capGroup,
    bounds: new THREE.Box3(), capsEnabled,
  };
}

// A view whose clip state has the given axes on (others off), else defaults.
function makeView({ renderMode = 'surface', solidFill = false, on = [], flip = false, showPlanes = true, pos = {} } = {}) {
  const clipState = createClipState();
  for (const ax of on) clipState[ax].on = true;
  for (const [ax, p] of Object.entries(pos)) clipState[ax].pos = p;
  clipState.flip = flip;
  clipState.showPlanes = showPlanes;
  return { renderMode, solidFill, clipState };
}

function boxMesh(w, h, d, color = 0xffffff) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
}

const BOUNDS = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));

describe('createClipState', () => {
  test('returns the default literal, fresh each call', () => {
    const a = createClipState();
    assert.deepEqual(a, {
      x: { on: false, pos: 0.5 }, y: { on: false, pos: 0.5 }, z: { on: false, pos: 0.5 },
      flip: false, showPlanes: true,
    });
    const b = createClipState();
    assert.notEqual(a, b);
    assert.notEqual(a.x, b.x);
    a.x.on = true;
    assert.equal(b.x.on, false);
  });
});

describe('clipPlaneFor', () => {
  test("x at 25% of [-10, 10] keeps the low side: normal -1, constant -5, cut -5", () => {
    const { normal, constant, cut } = clipPlaneFor('x', BOUNDS, 0.25, false);
    assert.deepEqual(normal.toArray(), [-1, 0, 0]);
    near(constant, -5);
    near(cut, -5);
  });

  test('flipped: normal +1, constant +5, same cut', () => {
    const { normal, constant, cut } = clipPlaneFor('x', BOUNDS, 0.25, true);
    assert.deepEqual(normal.toArray(), [1, 0, 0]);
    near(constant, 5);
    near(cut, -5);
  });

  test('y and z planes point down their own axis and the cut is on the plane', () => {
    const asym = new THREE.Box3(new THREE.Vector3(0, 2, -4), new THREE.Vector3(1, 6, 4));
    const y = clipPlaneFor('y', asym, 0.75, false);
    assert.deepEqual(y.normal.toArray(), [0, -1, 0]);
    near(y.cut, 5);
    near(y.constant, 5);
    const z = clipPlaneFor('z', asym, 0.5, true);
    assert.deepEqual(z.normal.toArray(), [0, 0, 1]);
    near(z.cut, 0);
    near(z.constant, 0);
    // Whatever the flip, the cut point lies on the plane (n·p + c = 0).
    for (const flip of [false, true]) {
      const { normal, constant, cut } = clipPlaneFor('y', asym, 0.3, flip);
      const p = new THREE.Vector3(0.5, cut, 0);
      near(new THREE.Plane(normal, constant).distanceToPoint(p), 0, `flip=${flip}`);
    }
  });
});

describe('sliceQuadPlacement', () => {
  const asym = new THREE.Box3(new THREE.Vector3(0, 2, -4), new THREE.Vector3(2, 6, 4));   // size 2×4×8, centre (1,4,0)

  test('x quad sits at the cut, centred in y/z, spanning z×y', () => {
    const { position, scale } = sliceQuadPlacement('x', asym, 0.25);
    assert.deepEqual(position.toArray(), [0.5, 4, 0]);
    assert.deepEqual(scale.toArray(), [8, 4, 1]);
  });

  test('y quad spans x×z at the cut height', () => {
    const { position, scale } = sliceQuadPlacement('y', asym, 0.5);
    assert.deepEqual(position.toArray(), [1, 4, 0]);
    assert.deepEqual(scale.toArray(), [2, 8, 1]);
  });

  test('z quad spans x×y at the cut depth', () => {
    const { position, scale } = sliceQuadPlacement('z', asym, 1);
    assert.deepEqual(position.toArray(), [1, 4, 4]);
    assert.deepEqual(scale.toArray(), [2, 4, 1]);
  });
});

describe('updateBounds', () => {
  test('is a no-op on an empty root (bounds stay empty, helpers untouched)', () => {
    const pane = fakePane();
    updateBounds(pane, makeView({ renderMode: 'slices', on: ['x'] }));
    assert.ok(pane.bounds.isEmpty());
    assert.deepEqual(pane.activeClips, []);
    assert.deepEqual(pane.boxHelper.scale.toArray(), [1, 1, 1]);
  });

  test('measures the root and places the bounding cube and grid floor', () => {
    const pane = fakePane();
    const mesh = boxMesh(2, 4, 6);
    mesh.position.set(10, 20, 30);
    pane.root.add(mesh);
    updateBounds(pane, makeView());
    near(pane.bounds.min.x, 9); near(pane.bounds.max.y, 22); near(pane.bounds.max.z, 33);
    assert.deepEqual(pane.boxHelper.scale.toArray().map((v) => Math.round(v * 1e9) / 1e9), [2, 4, 6]);
    assert.deepEqual(pane.boxHelper.position.toArray(), [10, 20, 30]);
    near(pane.grid.scale.x, 6 * 1.2); near(pane.grid.scale.y, 1); near(pane.grid.scale.z, 6 * 1.2);
    assert.deepEqual(pane.grid.position.toArray(), [10, 18, 30]);   // centre x/z, floor at min.y
  });

  test('chains into updateClips: an active axis becomes a clip plane', () => {
    const pane = fakePane();
    pane.root.add(boxMesh(20, 20, 20));
    updateBounds(pane, makeView({ on: ['y'] }));
    assert.equal(pane.activeClips.length, 1);
    assert.equal(pane.activeClips[0], pane.clipPlanes.y);
  });
});

describe('updateClips', () => {
  function measuredPane() {
    const pane = fakePane();
    pane.root.add(boxMesh(20, 20, 20));     // bounds [-10, 10]³
    pane.bounds.setFromObject(pane.root);
    return pane;
  }

  test('is a no-op while the bounds are empty', () => {
    const pane = fakePane();
    updateClips(pane, makeView({ on: ['x'], pos: { x: 0.25 } }));
    assert.deepEqual(pane.activeClips, []);
    assert.equal(pane.clipPlanes.x.constant, 0, 'plane untouched');
    assert.deepEqual(pane.sliceQuads.x.position.toArray(), [0, 0, 0], 'quad untouched');
  });

  test('with x on: only plane x is active, quad x placed/scaled/visible, others hidden', () => {
    const pane = measuredPane();
    updateClips(pane, makeView({ on: ['x'], pos: { x: 0.25 } }));
    assert.deepEqual(pane.activeClips, [pane.clipPlanes.x]);
    assert.deepEqual(pane.clipPlanes.x.normal.toArray(), [-1, 0, 0]);
    near(pane.clipPlanes.x.constant, -5);
    assert.deepEqual(pane.sliceQuads.x.position.toArray(), [-5, 0, 0]);
    assert.deepEqual(pane.sliceQuads.x.scale.toArray(), [20, 20, 1]);
    assert.equal(pane.sliceQuads.x.visible, true);
    assert.equal(pane.sliceQuads.y.visible, false);
    assert.equal(pane.sliceQuads.z.visible, false);
    // Inactive planes are still positioned so toggling them on later is instant.
    near(pane.clipPlanes.y.constant, 0);
    assert.deepEqual(pane.sliceQuads.z.position.toArray(), [0, 0, 0]);
  });

  test('re-running with a different state replaces activeClips rather than appending', () => {
    const pane = measuredPane();
    updateClips(pane, makeView({ on: ['x', 'z'] }));
    assert.deepEqual(pane.activeClips, [pane.clipPlanes.x, pane.clipPlanes.z]);
    updateClips(pane, makeView({ on: [] }));
    assert.deepEqual(pane.activeClips, []);
    assert.equal(pane.sliceQuads.x.visible, false);
  });

  test('flip reverses every plane normal and negates the constants', () => {
    const pane = measuredPane();
    updateClips(pane, makeView({ on: ['x'], pos: { x: 0.25, y: 0.75 }, flip: true }));
    assert.deepEqual(pane.clipPlanes.x.normal.toArray(), [1, 0, 0]);
    near(pane.clipPlanes.x.constant, 5);
    assert.deepEqual(pane.clipPlanes.y.normal.toArray(), [0, 1, 0]);
    near(pane.clipPlanes.y.constant, -5);
  });

  test('applies the render mode afterwards (materials receive the active planes)', () => {
    const pane = measuredPane();
    const [mesh] = pane.root.children;
    updateClips(pane, makeView({ renderMode: 'slices', on: ['x'] }));
    assert.equal(mesh.material.clippingPlanes, pane.activeClips);
    assert.equal(pane.sliceGroup.visible, true);
  });
});

describe('applyRenderModeToPane', () => {
  function pane3() {
    const pane = fakePane();
    pane.root.add(boxMesh(20, 20, 20));
    pane.bounds.setFromObject(pane.root);
    pane.activeClips = [pane.clipPlanes.x];
    return pane;
  }

  test('surface: no wireframe, no clipping planes, DoubleSide, helpers hidden', () => {
    const pane = pane3();
    const [mesh] = pane.root.children;
    mesh.material.side = THREE.FrontSide;
    const before = mesh.material.version;
    applyRenderModeToPane(pane, makeView({ renderMode: 'surface' }));
    assert.equal(mesh.material.wireframe, false);
    assert.equal(mesh.material.clippingPlanes, null);
    assert.equal(mesh.material.clipIntersection, false);
    assert.equal(mesh.material.side, THREE.DoubleSide);
    assert.equal(mesh.material.version, before + 1);
    assert.equal(pane.sliceGroup.visible, false);
    assert.equal(pane.boxHelper.visible, false);
  });

  test('wireframe: wireframe on, still unclipped', () => {
    const pane = pane3();
    const [mesh] = pane.root.children;
    applyRenderModeToPane(pane, makeView({ renderMode: 'wireframe' }));
    assert.equal(mesh.material.wireframe, true);
    assert.equal(mesh.material.clippingPlanes, null);
    assert.equal(pane.sliceGroup.visible, false);
  });

  test('slices: materials clip by the active planes; slice group and box helper show', () => {
    const pane = pane3();
    const [mesh] = pane.root.children;
    applyRenderModeToPane(pane, makeView({ renderMode: 'slices' }));
    assert.equal(mesh.material.wireframe, false);
    assert.equal(mesh.material.clippingPlanes, pane.activeClips);
    assert.equal(pane.sliceGroup.visible, true);
    assert.equal(pane.boxHelper.visible, true);
  });

  test('slices with no active plane: clippingPlanes null, planes still shown', () => {
    const pane = pane3();
    pane.activeClips = [];
    const [mesh] = pane.root.children;
    applyRenderModeToPane(pane, makeView({ renderMode: 'slices' }));
    assert.equal(mesh.material.clippingPlanes, null);
    assert.equal(pane.sliceGroup.visible, true);
  });

  test('slices with showPlanes off hides the slice group; empty bounds hide the box helper', () => {
    const pane = pane3();
    applyRenderModeToPane(pane, makeView({ renderMode: 'slices', showPlanes: false }));
    assert.equal(pane.sliceGroup.visible, false);
    assert.equal(pane.boxHelper.visible, true);
    pane.bounds.makeEmpty();
    applyRenderModeToPane(pane, makeView({ renderMode: 'slices' }));
    assert.equal(pane.boxHelper.visible, false);
    assert.equal(pane.sliceGroup.visible, true);
  });

  test('skips noClip helpers, keeps an anatomy material side, handles array and null materials', () => {
    const pane = pane3();
    const anat = boxMesh(1, 1, 1);
    anat.material.userData.anatomy = true;
    anat.material.side = THREE.BackSide;
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), null, new THREE.MeshStandardMaterial()]);
    pane.root.add(anat, multi);
    const quad = pane.sliceQuads.x;
    applyRenderModeToPane(pane, makeView({ renderMode: 'wireframe' }));
    assert.equal(anat.material.wireframe, true);
    assert.equal(anat.material.side, THREE.BackSide, 'anatomy side untouched');
    assert.equal(multi.material[0].wireframe, true);
    assert.equal(multi.material[2].side, THREE.DoubleSide);
    assert.equal(quad.material.wireframe, false, 'noClip helper untouched');
  });
});

describe('stencilMat', () => {
  test('writes stencil only: no colour/depth, one clipping plane, the op on every stencil path', () => {
    const plane = new THREE.Plane();
    const m = stencilMat(THREE.BackSide, THREE.IncrementWrapStencilOp, plane);
    assert.equal(m.colorWrite, false);
    assert.equal(m.depthWrite, false);
    assert.equal(m.depthTest, false);
    assert.equal(m.side, THREE.BackSide);
    assert.deepEqual(m.clippingPlanes, [plane]);
    assert.equal(m.stencilWrite, true);
    assert.equal(m.stencilFunc, THREE.AlwaysStencilFunc);
    assert.equal(m.stencilFail, THREE.IncrementWrapStencilOp);
    assert.equal(m.stencilZFail, THREE.IncrementWrapStencilOp);
    assert.equal(m.stencilZPass, THREE.IncrementWrapStencilOp);
  });
});

describe('collectCapCoats', () => {
  test('returns every showing mesh with its colour, in traversal order', () => {
    const root = new THREE.Group();
    const a = boxMesh(1, 1, 1, 0xff0000), b = boxMesh(1, 1, 1, 0x00ff00);
    const inner = new THREE.Group(); inner.add(b);
    root.add(a, inner);
    const coats = collectCapCoats(root);
    assert.deepEqual(coats.map((c) => c.mesh), [a, b]);
    assert.equal(coats[0].color, a.material.color);
    assert.equal(coats[1].color.getHex(), 0x00ff00);
  });

  test('skips hidden meshes, meshes under a hidden ancestor, helpers, back duplicates and bare meshes', () => {
    const root = new THREE.Group();
    const shown = boxMesh(1, 1, 1);
    const hidden = boxMesh(1, 1, 1); hidden.visible = false;
    const underHidden = boxMesh(1, 1, 1);
    const hiddenGroup = new THREE.Group(); hiddenGroup.visible = false; hiddenGroup.add(underHidden);
    const helper = boxMesh(1, 1, 1); helper.userData.noClip = true;
    const back = boxMesh(1, 1, 1); back.userData.anatomyBackOf = 'sclera';
    const noGeo = new THREE.Mesh(); noGeo.geometry = null;
    const noMat = new THREE.Mesh(new THREE.BoxGeometry()); noMat.material = null;
    root.add(shown, hidden, hiddenGroup, helper, back, noGeo, noMat);
    const coats = collectCapCoats(root);
    assert.deepEqual(coats.map((c) => c.mesh), [shown]);
  });

  test('an array material contributes its first entry colour', () => {
    const root = new THREE.Group();
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial({ color: 0x123456 }), new THREE.MeshStandardMaterial({ color: 0xabcdef })]);
    root.add(multi);
    assert.equal(collectCapCoats(root)[0].color.getHex(), 0x123456);
  });
});

describe('clearCaps', () => {
  test('disposes every cap material (single and array) and empties the group', () => {
    const pane = fakePane({ capsEnabled: true });
    const calls = [];
    const single = new THREE.Mesh(new THREE.BoxGeometry(), { dispose: () => calls.push('single') });
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [{ dispose: () => calls.push('m0') }, null, { dispose: () => calls.push('m2') }]);
    pane.capGroup.add(single, multi);
    clearCaps(pane);
    assert.deepEqual(calls, ['single', 'm0', 'm2']);
    assert.equal(pane.capGroup.children.length, 0);
  });

  test('tolerates a pane without a cap group', () => {
    assert.doesNotThrow(() => clearCaps({}));
  });
});

describe('buildCaps', () => {
  // stl-style pane: two coloured coats, bounds measured, one active x plane.
  function slicedPane({ capsEnabled = true, on = ['x'] } = {}) {
    const pane = fakePane({ capsEnabled });
    const outer = boxMesh(20, 20, 20, 0xff0000); outer.name = 'outer';
    const inner = boxMesh(10, 10, 10, 0x0000ff); inner.name = 'inner';
    pane.root.add(outer, inner);
    pane.bounds.setFromObject(pane.root);
    const view = makeView({ renderMode: 'slices', solidFill: true, on });
    updateClips(pane, view);   // places the planes and builds caps via applyRenderModeToPane
    return { pane, view, outer, inner };
  }

  test('gating: caps need capsEnabled, solidFill, slices mode and exactly one active plane', () => {
    assert.equal(slicedPane().pane.capGroup.children.length, 6, 'all conditions met');

    const noCaps = slicedPane({ capsEnabled: false });
    assert.equal(noCaps.pane.capGroup.children.length, 0);

    const { pane, view } = slicedPane();
    view.solidFill = false;
    buildCaps(pane, view);
    assert.equal(pane.capGroup.children.length, 0, 'solid fill off');

    view.solidFill = true; view.renderMode = 'surface';
    buildCaps(pane, view);
    assert.equal(pane.capGroup.children.length, 0, 'not slicing');

    view.renderMode = 'slices';
    buildCaps(pane, view);
    assert.equal(pane.capGroup.children.length, 6, 'back on');

    assert.equal(slicedPane({ on: ['x', 'y'] }).pane.capGroup.children.length, 0, 'two planes → uncapped');
    assert.equal(slicedPane({ on: [] }).pane.capGroup.children.length, 0, 'no plane');
  });

  test('a pane without capsEnabled keeps whatever is in its cap group (early return before clearCaps)', () => {
    const pane = fakePane({ capsEnabled: false });
    const stale = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    pane.capGroup.add(stale);
    buildCaps(pane, makeView({ renderMode: 'slices', solidFill: true }));
    assert.deepEqual(pane.capGroup.children, [stale]);
  });

  test('two coats → 6 children in render order 100,100,101,103,103,104', () => {
    const { pane } = slicedPane();
    assert.deepEqual(pane.capGroup.children.map((c) => c.renderOrder), [100, 100, 101, 103, 103, 104]);
    for (const c of pane.capGroup.children) {
      assert.equal(c.userData.noClip, true);
      assert.equal(c.frustumCulled, false);
    }
  });

  test('each coat gets a back-face increment pass and a front-face decrement pass sharing its geometry and world matrix', () => {
    const { pane, outer, inner } = slicedPane();
    outer.position.set(3, 4, 5);
    pane.root.updateWorldMatrix(true, true);
    buildCaps(pane, makeView({ renderMode: 'slices', solidFill: true, on: ['x'] }));
    const [bO, fO, , bI, fI] = pane.capGroup.children;
    assert.equal(bO.geometry, outer.geometry);
    assert.equal(fO.geometry, outer.geometry);
    assert.equal(bI.geometry, inner.geometry);
    assert.equal(fI.geometry, inner.geometry);
    assert.equal(bO.material.side, THREE.BackSide);
    assert.equal(bO.material.stencilZPass, THREE.IncrementWrapStencilOp);
    assert.equal(fO.material.side, THREE.FrontSide);
    assert.equal(fO.material.stencilZPass, THREE.DecrementWrapStencilOp);
    assert.equal(bO.material.colorWrite, false);
    assert.deepEqual(bO.material.clippingPlanes, [pane.clipPlanes.x]);
    assert.equal(bO.matrixAutoUpdate, false);
    assert.equal(bO.matrixWorldAutoUpdate, false);
    assert.ok(bO.matrixWorld.equals(outer.matrixWorld));
    assert.ok(bO.matrix.equals(outer.matrixWorld));
    assert.equal(bO.matrixWorld.elements[12], 3);
  });

  test('the cap quad: coat colour (a copy), NotEqual/Replace stencil, polygon offset by -order, posed on the plane', () => {
    const { pane, outer } = slicedPane();
    const [, , capO, , , capI] = pane.capGroup.children;
    const plane = pane.clipPlanes.x;

    assert.equal(capO.material.color.getHex(), 0xff0000);
    assert.notEqual(capO.material.color, outer.material.color);
    assert.equal(capI.material.color.getHex(), 0x0000ff);
    assert.equal(capO.material.side, THREE.DoubleSide);
    assert.equal(capO.material.stencilWrite, true);
    assert.equal(capO.material.stencilRef, 0);
    assert.equal(capO.material.stencilFunc, THREE.NotEqualStencilFunc);
    assert.equal(capO.material.stencilFail, THREE.ReplaceStencilOp);
    assert.equal(capO.material.stencilZFail, THREE.ReplaceStencilOp);
    assert.equal(capO.material.stencilZPass, THREE.ReplaceStencilOp);
    assert.equal(capO.material.polygonOffset, true);
    assert.equal(capO.material.polygonOffsetFactor, -100);
    assert.equal(capI.material.polygonOffsetFactor, -103);
    assert.equal(capO.material.polygonOffsetUnits, -1);

    // Size: 2.4× the largest bounds dimension (20 → 48), flat in z.
    assert.deepEqual(capO.scale.toArray(), [48, 48, 1]);
    // Pose: quad +z aligned with the plane normal, centred on the plane.
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(capO.quaternion);
    near(z.distanceTo(plane.normal), 0, 'quad faces along the normal');
    near(plane.distanceToPoint(capO.position), 0, 'quad sits on the plane');
    near(capO.position.length(), 0, 'x cut at 50% of [-10,10] is the origin');
    // Both caps share the one unit quad geometry.
    assert.equal(capO.geometry, capI.geometry);
    assert.equal(capO.geometry.attributes.position.count, 4);
  });

  test('the cap quad follows a moved cut and a flipped plane', () => {
    const { pane, view } = slicedPane();
    view.clipState.x.pos = 0.25; view.clipState.flip = true;
    updateClips(pane, view);
    const cap = pane.capGroup.children[2];
    near(cap.position.distanceTo(new THREE.Vector3(-5, 0, 0)), 0, 'cap at the 25% cut');
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(cap.quaternion);
    near(z.x, 1, 'faces +x after flip');
  });

  test('onAfterRender clears the stencil through the renderer it is handed', () => {
    const { pane } = slicedPane();
    const cap = pane.capGroup.children[2];
    assert.equal(typeof cap.onAfterRender, 'function');
    let cleared = 0;
    cap.onAfterRender({ clearStencil: () => { cleared++; } });
    assert.equal(cleared, 1);
  });

  test('hidden coats and anatomy back duplicates are not capped', () => {
    const { pane, view, inner } = slicedPane();
    inner.visible = false;
    const back = boxMesh(5, 5, 5); back.userData.anatomyBackOf = 'outer';
    pane.root.add(back);
    buildCaps(pane, view);
    assert.equal(pane.capGroup.children.length, 3);
    assert.deepEqual(pane.capGroup.children.map((c) => c.renderOrder), [100, 100, 101]);
    inner.visible = true;
    buildCaps(pane, view);
    assert.equal(pane.capGroup.children.length, 6);
  });

  test('rebuilding disposes the previous caps first', () => {
    const { pane, view } = slicedPane();
    const old = pane.capGroup.children.slice();
    const disposed = [];
    for (const c of old) c.material.dispose = () => disposed.push(c.renderOrder);
    buildCaps(pane, view);
    assert.deepEqual(disposed, [100, 100, 101, 103, 103, 104]);
    assert.equal(pane.capGroup.children.length, 6);
    for (const c of pane.capGroup.children) assert.ok(!old.includes(c));
  });

  test('nothing to cap: an empty root leaves the group empty', () => {
    const pane = fakePane({ capsEnabled: true });
    pane.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    pane.activeClips = [pane.clipPlanes.x];
    buildCaps(pane, makeView({ renderMode: 'slices', solidFill: true, on: ['x'] }));
    assert.equal(pane.capGroup.children.length, 0);
  });
});

describe('integration: updateBounds → updateClips → applyRenderModeToPane → buildCaps', () => {
  test('one updateBounds call in slices/solid-fill places the plane, clips the coats and builds their caps', () => {
    const pane = fakePane({ capsEnabled: true });
    const coats = namedBoxGroup(['sclera', 'choroid']);   // two unit boxes, x from -0.5 to 1.5
    pane.root.add(coats);
    const view = makeView({ renderMode: 'slices', solidFill: true, on: ['z'], pos: { z: 0.5 } });
    updateBounds(pane, view);

    near(pane.bounds.min.x, -0.5); near(pane.bounds.max.x, 1.5);
    assert.deepEqual(pane.activeClips, [pane.clipPlanes.z]);
    near(pane.clipPlanes.z.constant, 0);
    for (const mesh of coats.children) assert.equal(mesh.material.clippingPlanes, pane.activeClips);
    assert.equal(pane.sliceQuads.z.visible, true);
    assert.equal(pane.sliceGroup.visible, true);
    assert.equal(pane.boxHelper.visible, true);
    assert.deepEqual(pane.capGroup.children.map((c) => c.renderOrder), [100, 100, 101, 103, 103, 104]);
    // The stencil passes carry each coat's world placement (x offsets 0 and 1).
    assert.equal(pane.capGroup.children[0].matrixWorld.elements[12], 0);
    assert.equal(pane.capGroup.children[3].matrixWorld.elements[12], 1);
    // Cap size follows the largest bounds dimension (2 along x → 4.8).
    near(pane.capGroup.children[2].scale.x, 4.8);
  });

  test('switching back to surface clears the caps and unclips the coats', () => {
    const pane = fakePane({ capsEnabled: true });
    pane.root.add(namedBoxGroup(['a', 'b']));
    const view = makeView({ renderMode: 'slices', solidFill: true, on: ['x'] });
    updateBounds(pane, view);
    assert.equal(pane.capGroup.children.length, 6);
    view.renderMode = 'surface';
    applyRenderModeToPane(pane, view);
    assert.equal(pane.capGroup.children.length, 0);
    for (const mesh of pane.root.children[0].children) assert.equal(mesh.material.clippingPlanes, null);
    assert.equal(pane.sliceGroup.visible, false);
  });
});
