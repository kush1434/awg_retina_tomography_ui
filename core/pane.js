// ============================================================================
//  pane.js — one viewport: scene, lights, camera, orbit controls, the `root`
//  group that holds the subject and the slice helpers (clip planes, plane
//  quads, bounding cube, grid, stencil-cap group) that core/clipping.js
//  drives. Three-only: the renderer and the controls come from injected
//  `adapters` so the same factory builds a real WebGL pane in the browser and
//  a stub-backed one under Node.
// ============================================================================

import * as THREE from 'three';

export const PLANE_COLORS = { x: 0x7bd88f, y: 0xebb46e, z: 0x78aaeb };  // sagittal / axial / coronal

/**
 * Build a pane.
 *
 * @param {object} opts
 * @param {string} [opts.id] name the app uses to address the pane ('glb' | 'stl')
 * @param {boolean} [opts.capsEnabled=false] fill sliced cross-sections with stencil caps
 * @param {boolean} [opts.headLight=false] add a camera-tracking DirectionalLight (`pane.headLight`)
 * @param {{ createRenderer: Function, createControls: Function }} opts.adapters
 *   `createRenderer(opts)` returns a renderer (WebGLRenderer or a stub) and
 *   `createControls(camera, domElement)` returns OrbitControls-compatible
 *   controls. Required — there is deliberately no headless default.
 */
export function createPane({ id, capsEnabled = false, headLight = false, adapters } = {}) {
  if (!adapters?.createRenderer || !adapters?.createControls) {
    throw new TypeError('createPane: adapters { createRenderer, createControls } are required');
  }

  const scene = new THREE.Scene();

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x141820, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.05); key.position.set(1, 1.2, 1);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.45); fill.position.set(-1, -0.6, -0.8);
  scene.add(key, fill);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 1e7);
  camera.position.set(0, 0, 100);

  const renderer = adapters.createRenderer({ antialias: true, alpha: false, stencil: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;

  const controls = adapters.createControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.1;

  const root = new THREE.Group();
  scene.add(root);

  // Slice helpers (clip planes, plane quads, bounding box, grid).
  const clipPlanes = {
    x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    y: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    z: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  };
  const sliceGroup = new THREE.Group(); sliceGroup.visible = false; scene.add(sliceGroup);
  const sliceQuads = {};
  for (const ax of ['x', 'y', 'z']) {
    const mat = new THREE.MeshBasicMaterial({ color: PLANE_COLORS[ax], transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    q.userData.noClip = true;
    if (ax === 'x') q.rotation.y = Math.PI / 2;
    if (ax === 'y') q.rotation.x = Math.PI / 2;
    sliceQuads[ax] = q; sliceGroup.add(q);
  }
  const boxHelper = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 })
  );
  boxHelper.userData.noClip = true; boxHelper.visible = false; scene.add(boxHelper);

  const grid = new THREE.GridHelper(1, 20, 0x2a3340, 0x1a2029);
  grid.visible = false; grid.userData.noClip = true; scene.add(grid);

  // Holds stencil-cap geometry that fills the sliced cross-sections (see buildCaps).
  const capGroup = new THREE.Group(); capGroup.userData.noClip = true; scene.add(capGroup);

  // The shared key light sits behind and to the right of the subject, which suits
  // the µCT coats but leaves the anatomy's interior — iris, lens, the inside of
  // the cornea — lit only by ambient, washing their colour out to grey. The
  // anatomy pane asks for a soft headlight that tracks its camera (the app moves
  // it each frame), so whichever side you orbit to is the side that's lit.
  let head = null;
  if (headLight) {
    head = new THREE.DirectionalLight(0xfff6e8, 0.55);
    scene.add(head);
  }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  function render() { renderer.render(scene, camera); }
  function dispose() { controls.dispose(); renderer.dispose(); }

  return {
    id, scene, camera, renderer, controls, root,
    clipPlanes, activeClips: [], sliceGroup, sliceQuads, boxHelper, grid, capGroup,
    bounds: new THREE.Box3(), defaultDist: 100, capsEnabled, headLight: head,
    resize, render, dispose,
  };
}
