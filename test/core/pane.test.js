// ============================================================================
//  Tests for core/pane.js + core/adapters-headless.js — the adapter contract
//  (required, TypeError otherwise), the scene graph a pane builds (lights,
//  camera, root, hidden slice helpers, cap group, clip planes), the renderer
//  flags core sets itself, the real OrbitControls wired through the stub
//  element, resize / render / dispose, the headLight and capsEnabled options,
//  and the pane working end-to-end with core/clipping.js under Node.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPane, PLANE_COLORS } from '../../core/pane.js';
import { headlessAdapters, stubElement } from '../../core/adapters-headless.js';
import { createClipState, updateBounds, updateClips } from '../../core/clipping.js';

// Headless adapters whose renderer records every call it receives.
function recordingAdapters() {
  const base = headlessAdapters();
  const calls = [];
  const adapters = {
    createRenderer(opts) {
      calls.push(['createRenderer', opts]);
      const r = base.createRenderer(opts);
      for (const m of ['setSize', 'setPixelRatio', 'render', 'dispose']) {
        r[m] = (...args) => { calls.push([m, ...args]); };
      }
      return r;
    },
    createControls(camera, el) { calls.push(['createControls', camera, el]); return base.createControls(camera, el); },
  };
  return { adapters, calls };
}

function lightsOf(scene) { return scene.children.filter((o) => o.isLight); }

describe('createPane: adapter contract', () => {
  test('no arguments at all throws a TypeError', () => {
    assert.throws(() => createPane(), TypeError);
  });

  test('createPane({}) throws a TypeError naming the missing adapters', () => {
    assert.throws(() => createPane({}), { name: 'TypeError', message: /adapters \{ createRenderer, createControls \} are required/ });
  });

  test('createPane({ adapters: {} }) throws a TypeError', () => {
    assert.throws(() => createPane({ adapters: {} }), TypeError);
  });

  test('half an adapter set is rejected too', () => {
    const { createRenderer, createControls } = headlessAdapters();
    assert.throws(() => createPane({ adapters: { createRenderer } }), TypeError);
    assert.throws(() => createPane({ adapters: { createControls } }), TypeError);
  });

  test('createRenderer receives the WebGL options; createControls gets the camera and the canvas, after the renderer', () => {
    const { adapters, calls } = recordingAdapters();
    const pane = createPane({ adapters });
    assert.deepEqual(calls[0], ['createRenderer', { antialias: true, alpha: false, stencil: true }]);
    assert.equal(calls[1][0], 'createControls');
    assert.equal(calls[1][1], pane.camera);
    assert.equal(calls[1][2], pane.renderer.domElement);
  });

  test('core sets the colour space and local clipping on whatever renderer it is handed', () => {
    const pane = createPane({ adapters: headlessAdapters() });
    assert.equal(pane.renderer.outputColorSpace, THREE.SRGBColorSpace);
    assert.equal(pane.renderer.localClippingEnabled, true);
    assert.equal(pane.renderer.info.render.triangles, 0);
  });
});

describe('createPane: scene graph', () => {
  const pane = createPane({ id: 'stl', adapters: headlessAdapters() });

  test('id, defaults and the empty bounds box', () => {
    assert.equal(pane.id, 'stl');
    assert.equal(pane.capsEnabled, false);
    assert.equal(pane.headLight, null);
    assert.equal(pane.defaultDist, 100);
    assert.deepEqual(pane.activeClips, []);
    assert.ok(pane.bounds instanceof THREE.Box3);
    assert.ok(pane.bounds.isEmpty());
  });

  test('camera: fov 52, aspect 1, near 0.01, far 1e7, at z=100', () => {
    const c = pane.camera;
    assert.ok(c.isPerspectiveCamera);
    assert.equal(c.fov, 52);
    assert.equal(c.aspect, 1);
    assert.equal(c.near, 0.01);
    assert.equal(c.far, 1e7);
    // OrbitControls' constructor runs update(), which re-derives the position
    // from spherical coordinates — hence a tolerance rather than exact zeros.
    assert.ok(c.position.distanceTo(new THREE.Vector3(0, 0, 100)) < 1e-9, `camera at ${c.position.toArray()}`);
  });

  test('lights: ambient, hemisphere, key and fill (no headlight by default)', () => {
    const lights = lightsOf(pane.scene);
    assert.equal(lights.length, 4);
    const [amb, hemi, key, fill] = lights;
    assert.ok(amb.isAmbientLight); assert.equal(amb.intensity, 0.6);
    assert.ok(hemi.isHemisphereLight); assert.equal(hemi.intensity, 0.6);
    assert.ok(key.isDirectionalLight); assert.equal(key.intensity, 1.05);
    assert.deepEqual(key.position.toArray(), [1, 1.2, 1]);
    assert.ok(fill.isDirectionalLight); assert.equal(fill.intensity, 0.45);
    assert.deepEqual(fill.position.toArray(), [-1, -0.6, -0.8]);
  });

  test('root is an empty Group directly under the scene', () => {
    assert.ok(pane.root.isGroup);
    assert.equal(pane.root.parent, pane.scene);
    assert.equal(pane.root.children.length, 0);
  });

  test('three clip planes, one per axis, facing −axis at constant 0', () => {
    assert.deepEqual(pane.clipPlanes.x.normal.toArray(), [-1, 0, 0]);
    assert.deepEqual(pane.clipPlanes.y.normal.toArray(), [0, -1, 0]);
    assert.deepEqual(pane.clipPlanes.z.normal.toArray(), [0, 0, -1]);
    for (const ax of ['x', 'y', 'z']) assert.equal(pane.clipPlanes[ax].constant, 0);
  });

  test('sliceGroup is hidden and holds three translucent noClip quads in PLANE_COLORS', () => {
    assert.equal(pane.sliceGroup.visible, false);
    assert.equal(pane.sliceGroup.parent, pane.scene);
    assert.equal(pane.sliceGroup.children.length, 3);
    for (const ax of ['x', 'y', 'z']) {
      const q = pane.sliceQuads[ax];
      assert.equal(q.parent, pane.sliceGroup);
      assert.equal(q.userData.noClip, true);
      assert.equal(q.material.color.getHex(), PLANE_COLORS[ax]);
      assert.equal(q.material.transparent, true);
      assert.equal(q.material.opacity, 0.16);
      assert.equal(q.material.side, THREE.DoubleSide);
      assert.equal(q.material.depthWrite, false);
      assert.ok(q.geometry.isBufferGeometry);
    }
    // the x quad faces +x, the y quad faces +y, the z quad keeps the PlaneGeometry default
    assert.equal(pane.sliceQuads.x.rotation.y, Math.PI / 2);
    assert.equal(pane.sliceQuads.y.rotation.x, Math.PI / 2);
    assert.equal(pane.sliceQuads.z.rotation.x, 0);
    assert.equal(pane.sliceQuads.z.rotation.y, 0);
  });

  test('boxHelper is a hidden noClip edge wireframe at 12% opacity', () => {
    const b = pane.boxHelper;
    assert.ok(b.isLineSegments);
    assert.equal(b.visible, false);
    assert.equal(b.userData.noClip, true);
    assert.equal(b.parent, pane.scene);
    assert.equal(b.material.transparent, true);
    assert.equal(b.material.opacity, 0.12);
  });

  test('grid is a hidden noClip GridHelper', () => {
    assert.ok(pane.grid instanceof THREE.GridHelper);
    assert.equal(pane.grid.visible, false);
    assert.equal(pane.grid.userData.noClip, true);
    assert.equal(pane.grid.parent, pane.scene);
  });

  test('capGroup is an empty noClip group under the scene', () => {
    assert.ok(pane.capGroup.isGroup);
    assert.equal(pane.capGroup.userData.noClip, true);
    assert.equal(pane.capGroup.parent, pane.scene);
    assert.equal(pane.capGroup.children.length, 0);
  });

  test('PLANE_COLORS are the sagittal / axial / coronal tints', () => {
    assert.deepEqual(PLANE_COLORS, { x: 0x7bd88f, y: 0xebb46e, z: 0x78aaeb });
  });
});

describe('createPane: options', () => {
  test('capsEnabled is honoured', () => {
    assert.equal(createPane({ capsEnabled: true, adapters: headlessAdapters() }).capsEnabled, true);
  });

  test('headLight adds a warm DirectionalLight to the scene and exposes it', () => {
    const pane = createPane({ id: 'glb', headLight: true, adapters: headlessAdapters() });
    assert.ok(pane.headLight?.isDirectionalLight);
    assert.equal(pane.headLight.parent, pane.scene);
    assert.equal(pane.headLight.color.getHex(), 0xfff6e8);
    assert.equal(pane.headLight.intensity, 0.55);
    assert.equal(lightsOf(pane.scene).length, 5);
    // the app aims it every frame via its target, which must be a real Object3D
    assert.ok(pane.headLight.target.isObject3D);
  });

  test('two panes share nothing', () => {
    const a = createPane({ id: 'a', adapters: headlessAdapters() });
    const b = createPane({ id: 'b', adapters: headlessAdapters() });
    assert.notEqual(a.scene, b.scene);
    assert.notEqual(a.root, b.root);
    assert.notEqual(a.clipPlanes.x, b.clipPlanes.x);
    assert.notEqual(a.controls, b.controls);
    assert.notEqual(a.bounds, b.bounds);
  });
});

describe('createPane: controls', () => {
  const pane = createPane({ adapters: headlessAdapters() });

  test('controls are a real OrbitControls on the camera and the renderer canvas', () => {
    assert.ok(pane.controls instanceof OrbitControls);
    assert.equal(pane.controls.object, pane.camera);
    assert.equal(pane.controls.domElement, pane.renderer.domElement);
  });

  test('damping 0.08, auto-rotate speed 1.1, auto-rotate off', () => {
    assert.equal(pane.controls.enableDamping, true);
    assert.equal(pane.controls.dampingFactor, 0.08);
    assert.equal(pane.controls.autoRotateSpeed, 1.1);
    assert.equal(pane.controls.autoRotate, false);
  });

  test('the stub element is connected (touch scrolling disabled, as in a browser)', () => {
    assert.equal(pane.renderer.domElement.style.touchAction, 'none');
  });

  test('auto-rotate really orbits the camera headless and fires change', () => {
    const p = createPane({ adapters: headlessAdapters() });
    let changes = 0;
    p.controls.addEventListener('change', () => { changes++; });
    const before = p.controls.getAzimuthalAngle();
    p.controls.autoRotate = true;
    for (let i = 0; i < 5; i++) p.controls.update();
    assert.notEqual(p.controls.getAzimuthalAngle(), before);
    assert.ok(changes > 0);
    assert.ok(Math.abs(p.camera.position.length() - 100) < 1e-6, 'orbit keeps the distance');
  });
});

describe('createPane: resize / render / dispose', () => {
  test('resize(200, 400) sets aspect 0.5, refreshes the projection and forwards setSize(200, 400, false)', () => {
    const { adapters, calls } = recordingAdapters();
    const pane = createPane({ adapters });
    calls.length = 0;
    pane.resize(200, 400);
    assert.equal(pane.camera.aspect, 0.5);
    assert.deepEqual(calls, [['setSize', 200, 400, false]]);
    const expected = new THREE.PerspectiveCamera(52, 0.5, 0.01, 1e7);
    assert.deepEqual(pane.camera.projectionMatrix.toArray(), expected.projectionMatrix.toArray());
  });

  test('render() draws the pane scene with the pane camera', () => {
    const { adapters, calls } = recordingAdapters();
    const pane = createPane({ adapters });
    calls.length = 0;
    pane.render();
    assert.deepEqual(calls, [['render', pane.scene, pane.camera]]);
  });

  test('dispose() does not throw, disposes the renderer and disconnects the controls', () => {
    const { adapters, calls } = recordingAdapters();
    const pane = createPane({ adapters });
    calls.length = 0;
    assert.doesNotThrow(() => pane.dispose());
    assert.deepEqual(calls, [['dispose']]);
    assert.equal(pane.renderer.domElement.style.touchAction, 'auto');   // OrbitControls.disconnect ran
  });

  test('dispose() on a plain headless pane does not throw', () => {
    assert.doesNotThrow(() => createPane({ adapters: headlessAdapters() }).dispose());
  });
});

describe('headlessAdapters / stubElement', () => {
  test('stubElement() returns a fresh element each time whose root node is its ownerDocument', () => {
    const a = stubElement(), b = stubElement();
    assert.notEqual(a, b);
    assert.notEqual(a.style, b.style);
    assert.equal(a.getRootNode(), a.ownerDocument);
    assert.equal(a.clientWidth, 1);
    assert.equal(a.clientHeight, 1);
    assert.doesNotThrow(() => { a.addEventListener('x', () => {}); a.removeEventListener('x', () => {}); a.setPointerCapture(1); a.releasePointerCapture(1); });
  });

  test('createRenderer() is a stub with a canvas stand-in and zero triangles; createControls() is real', () => {
    const ad = headlessAdapters();
    const r = ad.createRenderer({ antialias: true });
    assert.equal(typeof r.domElement.addEventListener, 'function');
    assert.equal(r.info.render.triangles, 0);
    assert.doesNotThrow(() => { r.setSize(1, 1, false); r.setPixelRatio(2); r.render(); r.clearStencil(); r.dispose(); });
    r.outputColorSpace = 'x'; r.localClippingEnabled = true;
    assert.equal(r.outputColorSpace, 'x');
    const c = ad.createControls(new THREE.PerspectiveCamera(), r.domElement);
    assert.ok(c instanceof OrbitControls);
    c.dispose();
  });

  test('each createRenderer() call hands out its own element', () => {
    const ad = headlessAdapters();
    assert.notEqual(ad.createRenderer().domElement, ad.createRenderer().domElement);
  });
});

describe('pane + clipping under Node', () => {
  test('updateBounds → updateClips positions the helpers a headless pane built', () => {
    const pane = createPane({ adapters: headlessAdapters() });
    const view = { renderMode: 'slices', solidFill: false, clipState: createClipState() };
    view.clipState.x.on = true;
    pane.root.add(new THREE.Mesh(new THREE.BoxGeometry(10, 20, 30), new THREE.MeshStandardMaterial()));
    updateBounds(pane, view);
    assert.deepEqual(pane.boxHelper.scale.toArray(), [10, 20, 30]);
    assert.equal(pane.boxHelper.visible, true);
    assert.equal(pane.activeClips.length, 1);
    assert.equal(pane.activeClips[0], pane.clipPlanes.x);
    assert.equal(pane.sliceQuads.x.visible, true);
    assert.equal(pane.sliceQuads.y.visible, false);
    assert.equal(pane.sliceGroup.visible, true);
    // flipping the cut moves the plane the other way without touching the pane
    view.clipState.flip = true;
    updateClips(pane, view);
    assert.deepEqual(pane.clipPlanes.x.normal.toArray(), [1, 0, 0]);
  });
});
