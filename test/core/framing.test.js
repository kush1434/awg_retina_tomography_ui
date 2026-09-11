// ============================================================================
//  Tests for core/framing.js — the fit-distance rule (tighter of the vertical
//  and horizontal FOV), normalising a group to the overlay target, localBox's
//  transform round-trip, framing a box/object with a real PerspectiveCamera
//  and headless OrbitControls, and the visible-groups union box. Distinct from
//  test/geometry.test.js, which covers tools/bench.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  OVERLAY_TARGET, localBox, normalizeGroup, fitDistance, fitBox, fitToObject, unionBoxOfGroups,
} from '../../core/framing.js';
import { namedBoxGroup } from '../helpers/fixtures.js';

// The view direction viewer.js opens the reference eye on (ANATOMY_VIEW_DIR).
const VIEW_DIR = new THREE.Vector3(-0.72, 0.26, 0.64);
const EPS = 1e-9;

function makePane(fov = 52, aspect = 0.5) {
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 5000);
  camera.position.set(0, 0, 100);
  const controls = new OrbitControls(camera);          // headless: no element needed for target/update
  return { camera, controls, defaultDist: 100 };
}

function boxMesh(w, h, d) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial());
}

function near(a, b, msg) { assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} expected ${b}, got ${a}`); }

describe('fitDistance', () => {
  test('uses the horizontal FOV when the pane is tall and narrow', () => {
    const vFov = 52 * (Math.PI / 180);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * 0.5);
    assert.ok(hFov < vFov);
    const expected = (10 / 2) / Math.sin(hFov / 2);
    near(fitDistance({ fov: 52, aspect: 0.5 }, 10, 1.45), expected, 'narrow pane');
  });

  test('a narrow pane needs more distance than a wide one for the same box', () => {
    const narrow = fitDistance({ fov: 52, aspect: 0.5 }, 10, 1.45);
    const wide = fitDistance({ fov: 52, aspect: 2 }, 10, 1.45);
    assert.ok(narrow > wide);
    // With aspect 2 the vertical FOV is the tighter one.
    const vFov = 52 * (Math.PI / 180);
    near(wide, (10 / 2) / Math.sin(vFov / 2), 'wide pane');
  });

  test('offset scales the distance linearly, 1.45 being unity; aspect 0 counts as 1', () => {
    const snug = fitDistance({ fov: 52, aspect: 1 }, 10, 1.45);
    near(fitDistance({ fov: 52, aspect: 1 }, 10, 2.9), snug * 2, 'double offset');
    near(fitDistance({ fov: 52, aspect: 1 }, 10), snug, 'default offset');
    near(fitDistance({ fov: 52, aspect: 0 }, 10, 1.45), snug, 'aspect 0 → 1');
  });
});

describe('localBox', () => {
  test('measures the content ignoring the node transform and restores it', () => {
    const g = new THREE.Group();
    g.add(boxMesh(1, 1, 1));
    g.position.set(5, -3, 2);
    g.scale.setScalar(4);
    g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 3);
    g.updateMatrixWorld(true);
    const p = g.position.clone(), s = g.scale.clone(), q = g.quaternion.clone();

    const box = localBox(g);
    near(box.min.x, -0.5); near(box.max.x, 0.5);
    near(box.min.y, -0.5); near(box.max.y, 0.5);
    near(box.min.z, -0.5); near(box.max.z, 0.5);

    assert.ok(g.position.equals(p), 'position restored');
    assert.ok(g.scale.equals(s), 'scale restored');
    assert.ok(g.quaternion.equals(q), 'quaternion restored');
    // The world matrix is recomputed from the restored transform.
    const expected = new THREE.Matrix4().compose(p, q, s);
    assert.ok(g.matrixWorld.equals(expected), 'matrixWorld restored');
  });

  test('is empty for a group with no geometry', () => {
    assert.ok(localBox(new THREE.Group()).isEmpty());
  });
});

describe('normalizeGroup', () => {
  test('scales a 2×4×6 box to OVERLAY_TARGET on its longest side and centres it', () => {
    const g = new THREE.Group();
    const mesh = boxMesh(2, 4, 6);
    mesh.position.set(1, 2, 3);       // content centre is (1, 2, 3)
    g.add(mesh);
    normalizeGroup(g);
    const s = OVERLAY_TARGET / 6;
    near(g.scale.x, s); near(g.scale.y, s); near(g.scale.z, s);
    near(g.position.x, -s * 1);
    near(g.position.y, -s * 2);
    near(g.position.z, -s * 3);
    // The normalised content's world box is centred at the origin, 100 long.
    g.updateMatrixWorld(true);
    const world = new THREE.Box3().setFromObject(g);
    near(world.max.z - world.min.z, OVERLAY_TARGET);
    near(world.max.y - world.min.y, OVERLAY_TARGET * 4 / 6);
    near(world.min.x + world.max.x, 0);
  });

  test('offset {x: 0.4} shifts by 40 − s·center.x', () => {
    const g = new THREE.Group();
    const mesh = boxMesh(2, 4, 6);
    mesh.position.set(1, 2, 3);
    g.add(mesh);
    normalizeGroup(g, { x: 0.4, y: 0, z: 0 });
    const s = OVERLAY_TARGET / 6;
    near(g.position.x, 40 - s * 1);
    near(g.position.y, -s * 2);
    near(g.position.z, -s * 3);
  });

  test('honours an explicit target size', () => {
    const g = new THREE.Group();
    g.add(boxMesh(2, 4, 6));
    normalizeGroup(g, { x: 0, y: 0, z: 0 }, 50);
    near(g.scale.x, 50 / 6);
  });

  test('is idempotent: renormalising an already-normalised group lands in the same place', () => {
    const g = new THREE.Group();
    const mesh = boxMesh(2, 4, 6);
    mesh.position.set(1, 2, 3);
    g.add(mesh);
    normalizeGroup(g, { x: 0.4, y: -0.2, z: 0 });
    const p = g.position.clone(), s = g.scale.clone();
    normalizeGroup(g, { x: 0.4, y: -0.2, z: 0 });
    near(g.position.distanceTo(p), 0);
    near(g.scale.distanceTo(s), 0);
  });

  test('is a no-op on an empty group', () => {
    const g = new THREE.Group();
    g.position.set(7, 8, 9);
    g.scale.setScalar(3);
    normalizeGroup(g, { x: 0.4, y: 0, z: 0 });
    assert.deepEqual(g.position.toArray(), [7, 8, 9]);
    assert.deepEqual(g.scale.toArray(), [3, 3, 3]);
  });
});

describe('fitBox', () => {
  test('places the camera along the given direction at the fit distance and sets near/far/target/defaultDist', () => {
    const pane = makePane(52, 0.5);
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10));
    fitBox(pane, box, 1.75, VIEW_DIR);

    const dist = fitDistance(pane.camera, 10, 1.75);
    near(pane.defaultDist, dist, 'defaultDist');
    near(pane.controls.target.distanceTo(new THREE.Vector3(5, 5, 5)), 0, 'target at centre');

    const toCam = pane.camera.position.clone().sub(pane.controls.target);
    near(toCam.length(), dist, 'camera distance');
    near(toCam.normalize().distanceTo(VIEW_DIR.clone().normalize()), 0, 'camera along dir');
    assert.ok(!pane.camera.position.equals(new THREE.Vector3(0, 0, 100)), 'camera moved');

    near(pane.camera.near, 0.01, 'near');
    near(pane.camera.far, 10000, 'far');
    // controls.update() ran: the camera looks at the target.
    const fwd = new THREE.Vector3(); pane.camera.getWorldDirection(fwd);
    near(fwd.distanceTo(toCam.clone().negate()), 0, 'camera looks at target');
  });

  test('defaults to looking down +z with a snug 1.45 offset', () => {
    const pane = makePane(52, 0.5);
    const box = new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2));
    fitBox(pane, box);
    const dist = fitDistance(pane.camera, 4, 1.45);
    near(pane.camera.position.x, 0); near(pane.camera.position.y, 0); near(pane.camera.position.z, dist);
    near(pane.defaultDist, dist);
  });

  test('near never drops below 0.001 for a tiny box', () => {
    const pane = makePane();
    fitBox(pane, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.1, 0.1, 0.1)));
    near(pane.camera.near, 0.001);
  });

  test('an empty box is a no-op', () => {
    const pane = makePane();
    const pos = pane.camera.position.clone();
    fitBox(pane, new THREE.Box3(), 1.45, VIEW_DIR);
    assert.ok(pane.camera.position.equals(pos));
    assert.equal(pane.defaultDist, 100);
    near(pane.camera.near, 0.1);
  });
});

describe('fitToObject', () => {
  test('returns false and leaves the camera alone for an empty object', () => {
    const pane = makePane();
    const pos = pane.camera.position.clone();
    assert.equal(fitToObject(pane, new THREE.Group()), false);
    assert.ok(pane.camera.position.equals(pos));
    assert.equal(pane.defaultDist, 100);
  });

  test('returns true after framing a group', () => {
    const pane = makePane();
    const g = namedBoxGroup(['a', 'b', 'c']);      // x from -0.5 to 2.5
    assert.equal(fitToObject(pane, g, 1.6), true);
    near(pane.controls.target.x, 1);
    near(pane.defaultDist, fitDistance(pane.camera, 3, 1.6));
  });
});

describe('unionBoxOfGroups', () => {
  test('unions only visible, non-empty groups', () => {
    const shown = namedBoxGroup(['a']);                     // -0.5..0.5
    const hidden = namedBoxGroup(['h']); hidden.visible = false; hidden.position.x = 50;
    const empty = new THREE.Group(); empty.position.x = -50;
    const other = namedBoxGroup(['o']); other.position.x = 10;   // 9.5..10.5
    const root = new THREE.Group(); root.add(shown, hidden, empty, other);
    const box = unionBoxOfGroups([shown, hidden, empty, other], root);
    near(box.min.x, -0.5); near(box.max.x, 10.5);
  });

  test('accepts an iterator (Map.values()) like the sample-group map', () => {
    const m = new Map([['s1', namedBoxGroup(['a'])], ['s2', namedBoxGroup(['b', 'c'])]]);
    m.get('s2').position.y = 3;
    const box = unionBoxOfGroups(m.values(), null);
    near(box.min.y, -0.5); near(box.max.y, 3.5);
    near(box.max.x, 1.5);
  });

  test('falls back to the root when nothing is showing, and is empty without a root', () => {
    const hidden = namedBoxGroup(['h']); hidden.visible = false;
    const context = namedBoxGroup(['ctx']); context.position.set(4, 0, 0);
    const root = new THREE.Group(); root.add(hidden, context);
    const box = unionBoxOfGroups([hidden], root);
    assert.ok(!box.isEmpty());
    near(box.max.x, 4.5);
    assert.ok(unionBoxOfGroups([hidden], null).isEmpty());
    assert.ok(unionBoxOfGroups([], undefined).isEmpty());
  });
});
