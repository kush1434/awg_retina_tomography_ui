// ============================================================================
//  orientation.js — mirroring one pane's orbit orientation onto another.
//  applyOrientation() aims a pane's camera at its controls target from a given
//  azimuth / polar angle at its current distance; mirror() copies one pane's
//  angles onto a second pane behind a re-entrancy guard; CameraSync links two
//  panes' OrbitControls 'change' events so they stay in step. Three-only. The
//  sync flag has one owner — `CameraSync.enabled` — and the app only ever asks
//  it to link() / unlink().
// ============================================================================

import * as THREE from 'three';

/**
 * Place `pane`'s camera on the orbit sphere at azimuth `az` / polar angle
 * `polar` (OrbitControls' theta / phi), keeping its current distance and
 * target, then run the controls so their spherical state matches.
 */
export function applyOrientation(pane, az, polar) {
  const dist = pane.controls.getDistance();
  const t = pane.controls.target;
  const sp = Math.sin(polar);
  pane.camera.position.copy(t).add(new THREE.Vector3(sp * Math.sin(az), Math.cos(polar), sp * Math.cos(az)).multiplyScalar(dist));
  pane.camera.lookAt(t);
  pane.controls.update();
}

/**
 * Copy `from`'s orbit angles onto `to`; `to` keeps its own distance and target.
 * `guard.isSyncing` breaks the loop: applyOrientation calls controls.update(),
 * which fires 'change' on `to`, whose listener would otherwise mirror straight
 * back. A throwaway guard is used when none is passed.
 */
export function mirror(from, to, guard = { isSyncing: false }) {
  if (guard.isSyncing) return;
  guard.isSyncing = true;
  applyOrientation(to, from.controls.getAzimuthalAngle(), from.controls.getPolarAngle());
  guard.isSyncing = false;
}

/**
 * Keeps two panes' orbit orientation in step. The two listener closures are
 * created once so the add/removeEventListener pairs match; `link()` mirrors
 * `a` onto `b` immediately, then each pane follows the other's 'change'.
 * `enabled` is read-only from outside — link()/unlink() are the only writers.
 */
export class CameraSync {
  #enabled = false;

  constructor(a, b) {
    this.a = a;
    this.b = b;
    this.isSyncing = false;
    this.aToB = () => mirror(a, b, this);
    this.bToA = () => mirror(b, a, this);
  }

  get enabled() { return this.#enabled; }

  link() {
    this.#enabled = true;
    this.a.controls.addEventListener('change', this.aToB);
    this.b.controls.addEventListener('change', this.bToA);
    mirror(this.a, this.b, this);
  }

  unlink() {
    this.#enabled = false;
    this.a.controls.removeEventListener('change', this.aToB);
    this.b.controls.removeEventListener('change', this.bToA);
  }
}
