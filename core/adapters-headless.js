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
 * capture and a size. One fresh object per call.
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

/** `{ createRenderer, createControls }` for `createPane` / `createWorkbench` under Node. */
export function headlessAdapters() {
  return {
    createRenderer() {
      // Accepts the `outputColorSpace` / `localClippingEnabled` writes the pane
      // makes; `info.render.triangles` stays 0 (the stat needs a real renderer).
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
