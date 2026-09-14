// ============================================================================
//  adapters-headless.js — pane adapters for running the core library without
//  a browser: a stub renderer (no canvas, no GL) and the REAL three.js
//  OrbitControls attached to a stub element, so orbit maths, damping,
//  auto-rotate and 'change' events all behave as they do on screen. A test /
//  consumer helper — deliberately not part of the core barrel, so the app's
//  browser module graph never loads it.
// ============================================================================

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * The minimum an OrbitControls needs from its DOM element: listener
 * registration, a style bag, a root node with listeners of its own, pointer
 * capture and a size.
 * @returns {object} a fresh stub per call: addEventListener /
 *   removeEventListener, a style bag, an ownerDocument with listeners of its
 *   own (also what getRootNode returns), pointer capture, and a clientWidth /
 *   clientHeight of 1 — OrbitControls divides its pointer deltas by those, so
 *   the size has to be non-zero; the element has no real one, so pixel-scaled
 *   gestures are not meaningful headless.
 */
export function stubElement() {
  return {
    addEventListener() {}, removeEventListener() {},
    style: {},
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
    getRootNode() { return this.ownerDocument; },
    setPointerCapture() {}, releasePointerCapture() {},
    clientWidth: 1, clientHeight: 1,
  };
}

/**
 * `{ createRenderer, createControls }` for `createPane` / `createWorkbench`
 * under Node.
 *
 * Limitations worth knowing before you assert on anything: the stub renderer
 * accepts the `outputColorSpace` / `localClippingEnabled` writes the pane makes
 * (core/pane.js), but `render()` is a no-op and `info.render.triangles` stays
 * 0 — so the workbench's `stats` event always reports `triangles: 0` headless,
 * and nothing here verifies draw calls. Real OrbitControls are used, so orbit
 * maths, damping, auto-rotate and 'change' events behave as on screen.
 * @returns {{createRenderer: Function, createControls: Function}}
 */
export function headlessAdapters() {
  return {
    createRenderer() {
      return {
        domElement: stubElement(),
        setSize() {}, setPixelRatio() {}, render() {}, clearStencil() {},
        info: { render: { triangles: 0 } },
        dispose() {},
      };
    },
    createControls: (camera, el) => new OrbitControls(camera, el),
  };
}
