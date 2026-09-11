// ============================================================================
//  Tests for core/orientation.js — applyOrientation's angle / distance /
//  look-at rules and its controls.update() call, mirror() keeping the target
//  pane's own distance behind the re-entrancy guard, and CameraSync linking
//  two headless panes so a camera move on either side follows on the other
//  without ping-ponging, with `enabled` as the flag's only owner.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyOrientation, mirror, CameraSync } from '../../core/orientation.js';
import { createPane } from '../../core/pane.js';
import { headlessAdapters } from '../../core/adapters-headless.js';

const EPS = 1e-6;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, msg ?? `${a} !~ ${b}`);

// A headless pane whose camera sits `dist` from `target`, at the given angles.
function paneAt({ dist = 100, az = 0, polar = Math.PI / 2, target = [0, 0, 0] } = {}) {
  const pane = createPane({ adapters: headlessAdapters() });
  pane.controls.target.set(...target);
  pane.camera.position.set(target[0], target[1], target[2] + dist);
  pane.controls.update();
  applyOrientation(pane, az, polar);
  return pane;
}

const sameAngles = (p, q) => {
  near(p.controls.getAzimuthalAngle(), q.controls.getAzimuthalAngle(), 'azimuth differs');
  near(p.controls.getPolarAngle(), q.controls.getPolarAngle(), 'polar differs');
};
const countChanges = (pane) => { const c = { n: 0 }; pane.controls.addEventListener('change', () => { c.n++; }); return c; };

describe('applyOrientation', () => {
  test('lands on the requested azimuth / polar angle at the current distance', () => {
    const pane = paneAt({ dist: 40 });
    applyOrientation(pane, 0.7, 1.2);
    near(pane.controls.getAzimuthalAngle(), 0.7);
    near(pane.controls.getPolarAngle(), 1.2);
    near(pane.controls.getDistance(), 40, 'distance is preserved');
    near(pane.camera.position.length(), 40);
  });

  test('orbits around the controls target, not the origin, and looks at it', () => {
    const pane = paneAt({ dist: 25, target: [5, -3, 2] });
    applyOrientation(pane, -2.1, 0.4);
    const t = pane.controls.target;
    near(pane.camera.position.distanceTo(t), 25);
    near(pane.controls.getAzimuthalAngle(), -2.1);
    near(pane.controls.getPolarAngle(), 0.4);
    // the camera's forward axis points at the target
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pane.camera.quaternion);
    const toTarget = t.clone().sub(pane.camera.position).normalize();
    near(forward.dot(toTarget), 1, 'camera looks at the target');
  });

  test('polar angle measures from +y, azimuth from +z toward +x', () => {
    const pane = paneAt({ dist: 10 });
    applyOrientation(pane, 0, 0.001);           // straight above (OrbitControls clamps exact 0)
    assert.ok(pane.camera.position.y > 9.99);
    applyOrientation(pane, Math.PI / 2, Math.PI / 2);   // on +x
    near(pane.camera.position.x, 10);
    near(pane.camera.position.y, 0);
    near(pane.camera.position.z, 0);
  });

  test('calls controls.update() once so the controls see the new position', () => {
    const pane = paneAt();
    let updates = 0;
    const orig = pane.controls.update.bind(pane.controls);
    pane.controls.update = (...args) => { updates++; return orig(...args); };
    applyOrientation(pane, 1, 1);
    assert.equal(updates, 1);
  });

  test('a real move fires exactly one change event on the headless controls', () => {
    const pane = paneAt();
    const c = countChanges(pane);
    applyOrientation(pane, 1.5, 0.9);
    assert.equal(c.n, 1);
    applyOrientation(pane, 1.5, 0.9);   // same place again: no change
    assert.equal(c.n, 1);
  });
});

describe('mirror', () => {
  test('copies the angles onto the target pane, which keeps its own distance and target', () => {
    const from = paneAt({ dist: 100, az: 0.8, polar: 1.1 });
    const to = paneAt({ dist: 30, az: -1.0, polar: 2.0, target: [1, 2, 3] });
    mirror(from, to);
    near(to.controls.getAzimuthalAngle(), 0.8);
    near(to.controls.getPolarAngle(), 1.1);
    near(to.controls.getDistance(), 30);
    assert.deepEqual(to.controls.target.toArray(), [1, 2, 3]);
    // the source is untouched
    near(from.controls.getAzimuthalAngle(), 0.8);
    near(from.controls.getDistance(), 100);
  });

  test('is a no-op while the guard says a sync is in flight', () => {
    const from = paneAt({ az: 0.8, polar: 1.1 });
    const to = paneAt({ az: -1.0, polar: 2.0 });
    mirror(from, to, { isSyncing: true });
    near(to.controls.getAzimuthalAngle(), -1.0);
    near(to.controls.getPolarAngle(), 2.0);
  });

  test('sets the guard for the duration of the move and clears it afterwards', () => {
    const from = paneAt({ az: 0.8, polar: 1.1 });
    const to = paneAt();
    const guard = { isSyncing: false };
    let seen = null;
    to.controls.addEventListener('change', () => { seen = guard.isSyncing; });
    mirror(from, to, guard);
    assert.equal(seen, true, 'change fires inside the guarded region');
    assert.equal(guard.isSyncing, false);
  });
});

describe('CameraSync', () => {
  test('starts unlinked; enabled is read-only and follows link()/unlink()', () => {
    const s = new CameraSync(paneAt(), paneAt());
    assert.equal(s.enabled, false);
    assert.equal(s.isSyncing, false);
    assert.throws(() => { s.enabled = true; }, TypeError);
    s.link();
    assert.equal(s.enabled, true);
    s.unlink();
    assert.equal(s.enabled, false);
  });

  test('the two listener closures are created once, so add/remove pairs match', () => {
    const s = new CameraSync(paneAt(), paneAt());
    const { aToB, bToA } = s;
    assert.equal(typeof aToB, 'function');
    assert.equal(typeof bToA, 'function');
    s.link(); s.unlink(); s.link();
    assert.equal(s.aToB, aToB);
    assert.equal(s.bToA, bToA);
  });

  test('link() mirrors a onto b immediately, keeping b\'s distance', () => {
    const a = paneAt({ dist: 100, az: 0.6, polar: 1.3 });
    const b = paneAt({ dist: 45, az: -2.0, polar: 0.5 });
    new CameraSync(a, b).link();
    near(b.controls.getAzimuthalAngle(), 0.6);
    near(b.controls.getPolarAngle(), 1.3);
    near(b.controls.getDistance(), 45);
    near(a.controls.getAzimuthalAngle(), 0.6, 'a is the source and does not move');
  });

  test('while linked, a move on either pane follows on the other', () => {
    const a = paneAt(), b = paneAt({ dist: 60 });
    new CameraSync(a, b).link();
    applyOrientation(a, 1.1, 0.7);
    sameAngles(b, a);
    applyOrientation(b, -0.4, 2.2);
    near(a.controls.getAzimuthalAngle(), -0.4);
    near(a.controls.getPolarAngle(), 2.2);
    near(a.controls.getDistance(), 100);
    near(b.controls.getDistance(), 60);
  });

  test('the guard stops the mirrored change from bouncing back', () => {
    const a = paneAt(), b = paneAt();
    const s = new CameraSync(a, b);
    s.link();
    const ca = countChanges(a), cb = countChanges(b);
    applyOrientation(a, 1.1, 0.7);
    assert.equal(ca.n, 1, 'a changed once: b\'s change did not re-mirror onto a');
    assert.equal(cb.n, 1, 'b followed exactly once');
    assert.equal(s.isSyncing, false, 'guard cleared after the round trip');
    applyOrientation(b, 2.5, 1.9);
    assert.equal(cb.n, 2);
    assert.equal(ca.n, 2);
    assert.equal(s.isSyncing, false);
  });

  test('unlink() removes both listeners: neither pane follows the other any more', () => {
    const a = paneAt(), b = paneAt();
    const s = new CameraSync(a, b);
    s.link();
    s.unlink();
    applyOrientation(a, 1.1, 0.7);
    near(b.controls.getAzimuthalAngle(), 0);
    near(b.controls.getPolarAngle(), Math.PI / 2);
    applyOrientation(b, -1.5, 2.4);
    near(a.controls.getAzimuthalAngle(), 1.1);
    near(a.controls.getPolarAngle(), 0.7);
  });

  test('unlink() without a prior link() is harmless, and link() works again after unlink()', () => {
    const a = paneAt(), b = paneAt();
    const s = new CameraSync(a, b);
    assert.doesNotThrow(() => s.unlink());
    assert.equal(s.enabled, false);
    s.link(); s.unlink(); s.link();
    applyOrientation(a, 0.3, 1.0);
    sameAngles(b, a);
  });

  test('two panes that were never linked stay independent', () => {
    const a = paneAt(), b = paneAt();
    new CameraSync(a, b);   // constructed but not linked
    applyOrientation(a, 1.1, 0.7);
    near(b.controls.getAzimuthalAngle(), 0);
    near(b.controls.getPolarAngle(), Math.PI / 2);
  });
});
