// ============================================================================
//  browser-adapters.js — the browser half of a pane: the only place a
//  WebGLRenderer, the DOM-wired OrbitControls and a ResizeObserver are
//  constructed. `browserAdapters(mountEl)` feeds `createPane`; `mountPane`
//  keeps the pane sized to its element and returns the teardown.
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Adapters for a pane that renders into `mountEl`.
 * `createRenderer` appends the canvas before `createControls` runs, so the
 * controls attach to an element that is already in the document.
 */
export function browserAdapters(mountEl) {
  return {
    createRenderer(opts) {
      const renderer = new THREE.WebGLRenderer(opts);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      mountEl.appendChild(renderer.domElement);
      return renderer;
    },
    createControls: (camera, el) => new OrbitControls(camera, el),
  };
}

/**
 * Size the pane to `el` now and on every reflow.
 * @returns {{ measure: () => void, unmount: () => void }} `measure` re-reads
 *   the element size (the layout switch calls it after the panes reflow);
 *   `unmount` stops observing and removes the canvas — symmetric with `pane.dispose()`.
 */
export function mountPane(pane, el) {
  const measure = () => pane.resize(el.clientWidth || 1, el.clientHeight || 1);
  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  return { measure, unmount() { ro.disconnect(); pane.renderer.domElement.remove(); } };
}
