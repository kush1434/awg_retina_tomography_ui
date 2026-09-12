// ============================================================================
//  Tests for core/workbench.js — the facade running headless: construction
//  (two panes, shared vs per-pane adapters, no DOM read), the render-mode /
//  layout / clip / sync / auto-rotate / grid transitions and the events they
//  emit (in order), the display setters that delegate to the layer
//  controller, camera reset per pane, tick()'s frame body and stats window
//  with an injected clock, the frozen state() shape and dispose(). Meshes come
//  from the in-memory fixtures and bytes from stubIo; nothing here touches a
//  DOM.
// ============================================================================

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWorkbench } from '../../core/workbench.js';
import { headlessAdapters } from '../../core/adapters-headless.js';
import { applyOrientation } from '../../core/orientation.js';
import { fitDistance } from '../../core/framing.js';
import { clipPlaneFor } from '../../core/clipping.js';
import { ANATOMY_VIEW_DIR } from '../../core/anatomy.js';
import { modelById } from '../../core/anatomy-models.js';
import { binarySTL, glbWithNodes, stubIo } from '../helpers/fixtures.js';

const EPS = 1e-6;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, msg ?? `${a} !~ ${b}`);

// ---------------------------------------------------------------------------
//  Harness
// ---------------------------------------------------------------------------
const MESHEYE_URL = modelById('mesheye').url;
const UPAT_URL = modelById('upat').url;
const CUSTOM_URL = 'custom/eye.glb';
const F10_PATH = 'https://hf.example/resolve/main/F10_layers/retina.glb';
const F10_SOLID = 'optimized/F10_layers_solid/retina.glb';

const VIEW_EVENTS = ['rendermode', 'clip', 'layout', 'sync', 'autorotate', 'grid', 'opacity', 'linkoffsets', 'solidfill', 'stats'];
const STATE_KEYS = ['renderMode', 'layout', 'globalOpacity', 'autoRotate', 'linkOffsets', 'solidFill', 'grid', 'sync', 'clipState'];

// A data-loader-shaped structure record.
function structure(id, sampleId, over = {}) {
  return { id, sampleId, label: id.toUpperCase(), kind: 'stl', path: `${id}.stl`, color: 0xff0000, opacity: 1, bytes: null, ...over };
}
// A data-loader-shaped sample record.
function sample(id, structures, over = {}) {
  return { id, label: id.toUpperCase(), offset: { x: 0, y: 0, z: 0 }, opacity: 1, structures, ...over };
}
// Two samples: two STL layers + an F10 coat on s1, one STL layer on s2 (offset along x).
function twoSamples() {
  const a = structure('a', 's1'), b = structure('b', 's1');
  const f10 = structure('f10', 's1', { kind: 'gltf', path: F10_PATH, color: 0x00ff00 });
  const c = structure('c', 's2');
  return { a, b, c, f10, samples: [sample('s1', [a, b, f10]), sample('s2', [c], { offset: { x: 0.4, y: 0, z: 0 } })] };
}

/**
 * A headless workbench with a recording emitter over the view events (plus
 * whichever extra events a test names). Routes default to two STL layers,
 * an F10 coat with its solid variant, and the mesh.eye / upat / custom
 * anatomy models.
 */
function makeWb({ routes = null, options = {}, extraEvents = [], progressTicks = 2 } = {}) {
  const io = stubIo(routes ?? {
    'a.stl': binarySTL(2), 'b.stl': binarySTL(3), 'c.stl': binarySTL(4),
    [F10_PATH]: glbWithNodes(['retina']), [F10_SOLID]: glbWithNodes(['retina_solid']),
    [MESHEYE_URL]: glbWithNodes(['sclera', 'choroid', 'retina', 'cornea', 'lens']),
    [UPAT_URL]: glbWithNodes(['globe', 'pupil', 'lateral_rectus']),
    [CUSTOM_URL]: glbWithNodes(['foo', 'bar']),
    progressTicks,
  });
  const wb = createWorkbench({ adapters: headlessAdapters(), io, ...options });
  const events = [];
  for (const evt of [...VIEW_EVENTS, ...extraEvents]) wb.on(evt, (payload) => events.push({ evt, ...payload }));
  const of = (evt) => events.filter((e) => e.evt === evt);
  const names = () => events.map((e) => e.evt);
  const fixtures = twoSamples();
  wb.layers.setSamples(fixtures.samples);
  return { wb, io, events, of, names, ...fixtures, glb: wb.panes.glb, stl: wb.panes.stl };
}

const maxDim = (box) => { const s = box.getSize(new THREE.Vector3()); return Math.max(s.x, s.y, s.z) || 1; };
const quiet = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); };

// ---------------------------------------------------------------------------
//  Construction
// ---------------------------------------------------------------------------
describe('construction', () => {
  test('builds a headlit glb pane and a capped stl pane, wired to the sync and both controllers', () => {
    const { wb, glb, stl } = makeWb();
    assert.equal(glb.id, 'glb');
    assert.ok(glb.headLight instanceof THREE.DirectionalLight);
    assert.equal(glb.capsEnabled, false);
    assert.equal(stl.id, 'stl');
    assert.equal(stl.headLight, null);
    assert.equal(stl.capsEnabled, true);
    assert.equal(wb.layers.pane, stl);
    assert.equal(wb.anatomy.glb, glb);
    assert.equal(wb.anatomy.stl, stl);
    assert.equal(wb.anatomy.layers, wb.layers);
    assert.equal(wb.sync.a, glb);
    assert.equal(wb.sync.b, stl);
    assert.equal(wb.sync.enabled, false);
    assert.equal(glb.root.children.length, 0);
    assert.equal(stl.root.children.length, 0);
  });

  test('accepts one shared adapter set or one per pane', () => {
    const shared = headlessAdapters();
    const sharedSpy = mock.method(shared, 'createRenderer');
    createWorkbench({ adapters: shared });
    assert.equal(sharedSpy.mock.callCount(), 2);

    const glbA = headlessAdapters(), stlA = headlessAdapters();
    const glbSpy = mock.method(glbA, 'createRenderer'), stlSpy = mock.method(stlA, 'createRenderer');
    const wb = createWorkbench({ adapters: { glb: glbA, stl: stlA } });
    assert.equal(glbSpy.mock.callCount(), 1);
    assert.equal(stlSpy.mock.callCount(), 1);
    assert.equal(wb.panes.glb.renderer, glbSpy.mock.calls[0].result);
    assert.equal(wb.panes.stl.renderer, stlSpy.mock.calls[0].result);
  });

  test('throws a TypeError without adapters — there is no headless default', () => {
    assert.throws(() => createWorkbench(), TypeError);
    assert.throws(() => createWorkbench({}), TypeError);
    assert.throws(() => createWorkbench({ adapters: {} }), TypeError);
    assert.throws(() => createWorkbench({ adapters: { glb: headlessAdapters() } }), TypeError);
  });

  test('forwards modelId / anatomyUrl to the anatomy controller and io to both controllers', () => {
    const io = stubIo({});
    const wb = createWorkbench({ adapters: headlessAdapters(), io, modelId: 'upat', anatomyUrl: CUSTOM_URL });
    assert.equal(wb.anatomy.modelId(), 'upat');
    assert.equal(wb.anatomy.url(), CUSTOM_URL);
    assert.equal(wb.layers.io, io);
    assert.equal(wb.anatomy.io, io);
    assert.equal(wb.layers.parsers, wb.anatomy.parsers);
    assert.equal(createWorkbench({ adapters: headlessAdapters() }).anatomy.modelId(), 'mesheye');
  });

  test('never reads globalThis.document while constructing', () => {
    let touched = 0;
    Object.defineProperty(globalThis, 'document', { configurable: true, get() { touched++; return undefined; } });
    try {
      const wb = createWorkbench({ adapters: headlessAdapters() });
      wb.setRenderMode('surface');
      wb.tick(0);
    } finally {
      delete globalThis.document;
    }
    assert.equal(touched, 0);
  });

  test('starts in surface / split, opaque, static, unlinked, hollow, gridless, unsynced and uncut', () => {
    const { wb } = makeWb();
    assert.deepEqual(wb.state(), {
      renderMode: 'surface', layout: 'split', globalOpacity: 1, autoRotate: false,
      linkOffsets: false, solidFill: false, grid: false, sync: false,
      clipState: { x: { on: false, pos: 0.5 }, y: { on: false, pos: 0.5 }, z: { on: false, pos: 0.5 }, flip: false, showPlanes: true },
    });
  });
});

// ---------------------------------------------------------------------------
//  Render mode
// ---------------------------------------------------------------------------
describe('setRenderMode', () => {
  test('the initial surface call still emits rendermode (the app renders from it) and applies the mode', async () => {
    const { wb, of, a, stl } = makeWb();
    await wb.layers.load(a);
    wb.setRenderMode('surface');
    assert.deepEqual(of('rendermode'), [{ evt: 'rendermode', mode: 'surface' }]);
    assert.equal(wb.state().renderMode, 'surface');
    assert.equal(wb.layers.featureObjects.get('a').material.wireframe, false);
    assert.equal(stl.boxHelper.visible, false);
  });

  test('wireframe re-skins every loaded mesh and leaves the clips alone', async () => {
    const { wb, of, a, stl } = makeWb();
    await wb.layers.load(a);
    wb.setRenderMode('wireframe');
    assert.equal(wb.layers.featureObjects.get('a').material.wireframe, true);
    assert.equal(of('clip').length, 0);
    assert.equal(stl.activeClips.length, 0);
    assert.equal(wb.state().renderMode, 'wireframe');
  });

  test('entering slices with nothing cut enables the X axis: clip is emitted before rendermode, then the panes are cut', async () => {
    const { wb, names, of, a, stl } = makeWb();
    await wb.layers.load(a);
    wb.setRenderMode('slices');
    assert.deepEqual(names(), ['clip', 'rendermode']);
    assert.equal(of('clip')[0].x.on, true);
    assert.equal(of('clip')[0].y.on, false);
    assert.equal(of('rendermode')[0].mode, 'slices');
    assert.equal(wb.state().clipState.x.on, true);
    assert.equal(stl.activeClips.length, 1);
    assert.equal(stl.activeClips[0], stl.clipPlanes.x);
    assert.equal(stl.sliceQuads.x.visible, true);
    assert.equal(stl.boxHelper.visible, true);
    assert.deepEqual(wb.layers.featureObjects.get('a').material.clippingPlanes, [stl.clipPlanes.x]);
  });

  test('entering slices with an axis already cut leaves X alone and emits no clip', async () => {
    const { wb, names, a, stl } = makeWb();
    await wb.layers.load(a);
    wb.setClipAxis('y', true);
    const before = names().length;
    wb.setRenderMode('slices');
    assert.deepEqual(names().slice(before), ['rendermode']);
    assert.equal(wb.state().clipState.x.on, false);
    assert.equal(wb.state().clipState.y.on, true);
    assert.deepEqual(stl.activeClips, [stl.clipPlanes.y]);
  });

  test('entering slices before anything is loaded flips X without cutting an empty pane', () => {
    const { wb, names, stl, glb } = makeWb();
    wb.setRenderMode('slices');
    assert.deepEqual(names(), ['clip', 'rendermode']);
    assert.equal(wb.state().clipState.x.on, true);
    assert.equal(stl.activeClips.length, 0);
    assert.equal(glb.activeClips.length, 0);
    assert.equal(stl.boxHelper.visible, false);   // no bounds yet
  });
});

// ---------------------------------------------------------------------------
//  Clip setters
// ---------------------------------------------------------------------------
describe('clip setters', () => {
  test('setClipAxis / setClipPos / setClipFlip each emit clip and re-place the planes', async () => {
    const { wb, of, a, stl } = makeWb();
    await wb.layers.load(a);
    const b = stl.bounds;

    wb.setClipAxis('y', true);
    assert.equal(of('clip').at(-1).y.on, true);
    assert.deepEqual(stl.activeClips, [stl.clipPlanes.y]);

    wb.setClipPos('y', 0.25);
    const expect25 = clipPlaneFor('y', b, 0.25, false);
    assert.equal(of('clip').at(-1).y.pos, 0.25);
    near(stl.clipPlanes.y.constant, expect25.constant);
    near(stl.clipPlanes.y.normal.y, -1);
    near(stl.sliceQuads.y.position.y, expect25.cut);

    wb.setClipFlip(true);
    const flipped = clipPlaneFor('y', b, 0.25, true);
    assert.equal(of('clip').at(-1).flip, true);
    near(stl.clipPlanes.y.constant, flipped.constant);
    near(stl.clipPlanes.y.normal.y, 1);
    assert.equal(of('clip').length, 3);
    assert.deepEqual(wb.state().clipState, { x: { on: false, pos: 0.5 }, y: { on: true, pos: 0.25 }, z: { on: false, pos: 0.5 }, flip: true, showPlanes: true });
  });

  test('setShowPlanes hides the slice quads in slices mode and emits clip', async () => {
    const { wb, of, a, stl } = makeWb();
    await wb.layers.load(a);
    wb.setRenderMode('slices');
    assert.equal(stl.sliceGroup.visible, true);
    wb.setShowPlanes(false);
    assert.equal(of('clip').at(-1).showPlanes, false);
    assert.equal(stl.sliceGroup.visible, false);
    assert.equal(wb.state().clipState.showPlanes, false);
    wb.setShowPlanes(true);
    assert.equal(stl.sliceGroup.visible, true);
    wb.setRenderMode('surface');
    assert.equal(stl.sliceGroup.visible, false);   // planes only show while slicing
  });

  test('clip payloads are frozen snapshots that later setters do not rewrite', () => {
    const { wb, of } = makeWb();
    wb.setClipAxis('x', true);
    const first = of('clip')[0];
    wb.setClipAxis('x', false);
    assert.equal(first.x.on, true);
    assert.ok(Object.isFrozen(first.x));
    assert.throws(() => { first.x.on = false; }, TypeError);
    assert.equal(of('clip')[1].x.on, false);
  });
});

// ---------------------------------------------------------------------------
//  Layout
// ---------------------------------------------------------------------------
describe('setLayout / refitAfterReflow', () => {
  test('emits layout before the anatomy is re-parented, then places it in the workspace and back', async () => {
    const { wb, of, glb, stl } = makeWb();
    await wb.anatomy.load();
    assert.equal(wb.anatomy.object.parent, glb.root);

    let parentAtEmit = null;
    wb.on('layout', () => { parentAtEmit = wb.anatomy.object.parent; });
    wb.setLayout('overlay');
    assert.deepEqual(of('layout'), [{ evt: 'layout', layout: 'overlay' }]);
    assert.equal(parentAtEmit, glb.root, 'listener runs before place()');
    assert.equal(wb.anatomy.group.parent, stl.root);
    assert.equal(wb.anatomy.object.parent, wb.anatomy.group);
    assert.equal(wb.state().layout, 'overlay');

    wb.setLayout('split');
    assert.equal(of('layout').at(-1).layout, 'split');
    assert.equal(wb.anatomy.object.parent, glb.root);
    assert.equal(wb.anatomy.group.parent, null);
    assert.equal(wb.state().layout, 'split');
  });

  test('setLayout ends by re-applying the render mode to both panes', async () => {
    const { wb, a, stl } = makeWb();
    await wb.layers.load(a);
    wb.setRenderMode('wireframe');
    wb.layers.featureObjects.get('a').material.wireframe = false;   // knock it out of step
    wb.setLayout('overlay');
    assert.equal(wb.layers.featureObjects.get('a').material.wireframe, true);
    assert.equal(stl.boxHelper.visible, false);
  });

  test('refitAfterReflow fits the workspace at 1.7 for overlay and 1.45 for split, and is a no-op when empty', async () => {
    const { wb, a, stl } = makeWb();
    wb.refitAfterReflow('overlay');
    assert.equal(stl.defaultDist, 100);

    await wb.layers.load(a);
    const dim = maxDim(wb.layers.workspaceBox());
    wb.refitAfterReflow('overlay');
    near(stl.defaultDist, fitDistance(stl.camera, dim, 1.7));
    wb.refitAfterReflow('split');
    near(stl.defaultDist, fitDistance(stl.camera, dim, 1.45));
    assert.equal(stl.bounds.isEmpty(), false);
  });

  test('refitAfterReflow also refits when only the anatomy is in the workspace', async () => {
    const { wb, stl } = makeWb();
    await wb.anatomy.load();
    wb.setLayout('overlay');
    stl.defaultDist = 1;
    wb.refitAfterReflow('overlay');
    assert.notEqual(stl.defaultDist, 1);
    near(stl.defaultDist, fitDistance(stl.camera, maxDim(wb.layers.workspaceBox()), 1.7));
  });
});

// ---------------------------------------------------------------------------
//  Sync
// ---------------------------------------------------------------------------
describe('setSync', () => {
  test('emits sync before linking, then a stl move mirrors onto glb; unlinking stops it', () => {
    const { wb, of, glb, stl } = makeWb();
    let enabledAtEmit = null;
    wb.on('sync', () => { enabledAtEmit = wb.sync.enabled; });

    wb.setSync(true);
    assert.deepEqual(of('sync'), [{ evt: 'sync', on: true }]);
    assert.equal(enabledAtEmit, false, 'listener sees the pre-link state');
    assert.equal(wb.sync.enabled, true);
    assert.equal(wb.state().sync, true);

    applyOrientation(stl, 1.1, 0.7);
    near(glb.controls.getAzimuthalAngle(), 1.1);
    near(glb.controls.getPolarAngle(), 0.7);

    wb.setSync(false);
    assert.equal(of('sync').at(-1).on, false);
    assert.equal(wb.sync.enabled, false);
    assert.equal(wb.state().sync, false);
    applyOrientation(stl, -0.4, 2.2);
    near(glb.controls.getAzimuthalAngle(), 1.1);
    near(glb.controls.getPolarAngle(), 0.7);
  });

  test('state().sync is derived from CameraSync.enabled — linking directly is reflected too', () => {
    const { wb } = makeWb();
    wb.sync.link();
    assert.equal(wb.state().sync, true);
    wb.sync.unlink();
    assert.equal(wb.state().sync, false);
  });
});

// ---------------------------------------------------------------------------
//  Auto-rotate and grid
// ---------------------------------------------------------------------------
describe('setAutoRotate / setGrid', () => {
  test('setAutoRotate sets both controls and emits autorotate', () => {
    const { wb, of, glb, stl } = makeWb();
    wb.setAutoRotate(true);
    assert.equal(glb.controls.autoRotate, true);
    assert.equal(stl.controls.autoRotate, true);
    assert.equal(wb.state().autoRotate, true);
    assert.deepEqual(of('autorotate'), [{ evt: 'autorotate', on: true }]);
    wb.setAutoRotate(false);
    assert.equal(glb.controls.autoRotate, false);
    assert.equal(stl.controls.autoRotate, false);
    assert.equal(wb.state().autoRotate, false);
  });

  test('setGrid shows the grid only on a pane with bounds, remembers the flag and emits grid', async () => {
    const { wb, of, a, glb, stl } = makeWb();
    wb.setGrid(true);
    assert.equal(stl.grid.visible, false);    // nothing loaded: empty bounds
    assert.equal(glb.grid.visible, false);
    assert.equal(wb.state().grid, true);
    assert.deepEqual(of('grid'), [{ evt: 'grid', on: true }]);

    await wb.layers.load(a);
    wb.setGrid(true);
    assert.equal(stl.grid.visible, true);
    assert.equal(glb.grid.visible, false);
    wb.setGrid(false);
    assert.equal(stl.grid.visible, false);
    assert.equal(wb.state().grid, false);
    assert.equal(of('grid').length, 3);
  });
});

// ---------------------------------------------------------------------------
//  Display setters that delegate to the layer controller
// ---------------------------------------------------------------------------
describe('setGlobalOpacity / setLinkOffsets / setSolidFill', () => {
  test('setGlobalOpacity re-applies every loaded layer and emits opacity', async () => {
    const { wb, of, a } = makeWb();
    await wb.layers.load(a);
    const mat = wb.layers.featureObjects.get('a').material;
    wb.setGlobalOpacity(0.5);
    assert.equal(mat.opacity, 0.5);
    assert.equal(mat.transparent, true);
    assert.equal(wb.state().globalOpacity, 0.5);
    assert.deepEqual(of('opacity'), [{ evt: 'opacity', global: 0.5 }]);
    wb.setGlobalOpacity(1);
    assert.equal(mat.opacity, 1);
    assert.equal(mat.transparent, false);
  });

  test('setLinkOffsets(true) snaps every sample to the first one (one sample:offset per axis) and emits linkoffsets', () => {
    const { wb, of, samples } = makeWb({ extraEvents: ['sample:offset'] });
    assert.equal(samples[1].offset.x, 0.4);
    wb.setLinkOffsets(true);
    assert.equal(wb.state().linkOffsets, true);
    assert.equal(samples[1].offset.x, 0);
    assert.equal(of('sample:offset').length, 6);
    assert.deepEqual(of('sample:offset').map((e) => e.sampleId), ['s1', 's2', 's1', 's2', 's1', 's2']);
    assert.deepEqual(of('linkoffsets'), [{ evt: 'linkoffsets', on: true }]);

    samples[1].offset.x = 0.3;
    wb.setLinkOffsets(false);
    assert.equal(samples[1].offset.x, 0.3, 'unlinking does not snap');
    assert.equal(of('sample:offset').length, 6);
    assert.equal(wb.state().linkOffsets, false);
  });

  test('setSolidFill emits synchronously, then reloads the F10 coats from the solid variant', async () => {
    const { wb, of, io, f10 } = makeWb({ extraEvents: ['layers:visible'] });
    await wb.layers.load(f10);
    const visibleBefore = of('layers:visible').length;

    const p = wb.setSolidFill(true);
    assert.deepEqual(of('solidfill'), [{ evt: 'solidfill', on: true }]);
    assert.equal(wb.state().solidFill, true);
    assert.ok(p instanceof Promise);
    await p;
    assert.ok(io.calls.some((c) => c.url === F10_SOLID), 'solid variant fetched');
    assert.equal(wb.layers.effectivePath(f10), F10_SOLID);
    assert.equal(of('layers:visible').length, visibleBefore + 2);   // N + 1 emissions for one coat
    assert.equal(of('layers:visible').at(-1).anyVisible, true);
  });
});

// ---------------------------------------------------------------------------
//  Camera reset
// ---------------------------------------------------------------------------
describe('resetPane / resetAll', () => {
  test("resetPane('stl') refits the workspace at 1.45 (1.7 in overlay) and recomputes defaultDist", async () => {
    const { wb, a, stl } = makeWb();
    await wb.layers.load(a);
    const dim = maxDim(wb.layers.workspaceBox());
    stl.camera.position.set(500, 500, 500); stl.controls.update(); stl.defaultDist = 1;

    wb.resetPane('stl');
    near(stl.defaultDist, fitDistance(stl.camera, dim, 1.45));
    near(stl.controls.getDistance(), stl.defaultDist);

    wb.setLayout('overlay');
    stl.defaultDist = 1;
    wb.resetPane('stl');
    near(stl.defaultDist, fitDistance(stl.camera, dim, 1.7));
  });

  test("resetPane('glb') with the anatomy loaded frames its focus box along ANATOMY_VIEW_DIR", async () => {
    const { wb, glb } = makeWb();
    await wb.anatomy.load();
    glb.camera.position.set(0, 0, 900); glb.controls.update(); glb.defaultDist = 1;

    wb.resetPane('glb');
    const box = wb.anatomy.focusBox();
    near(glb.defaultDist, fitDistance(glb.camera, maxDim(box), 1.75));
    const dir = glb.camera.position.clone().sub(glb.controls.target).normalize();
    const want = ANATOMY_VIEW_DIR.clone().normalize();
    near(dir.x, want.x); near(dir.y, want.y); near(dir.z, want.z);
    const c = box.getCenter(new THREE.Vector3());
    near(glb.controls.target.x, c.x); near(glb.controls.target.y, c.y); near(glb.controls.target.z, c.z);
  });

  test("resetPane('glb') with a model that has no recognised parts fits the root and refreshes the bounds", async (t) => {
    quiet(t);
    const { wb, glb } = makeWb({ options: { anatomyUrl: CUSTOM_URL } });
    await wb.anatomy.load();
    assert.equal(wb.anatomy.parts.size, 0);
    assert.equal(glb.root.children.length, 1);
    glb.defaultDist = 1;
    wb.resetPane('glb');
    near(glb.defaultDist, fitDistance(glb.camera, maxDim(new THREE.Box3().setFromObject(glb.root)), 1.45));
    assert.equal(glb.bounds.isEmpty(), false);
  });

  test('resetPane on an empty pane changes nothing', () => {
    const { wb, glb, stl } = makeWb();
    wb.resetPane('glb'); wb.resetPane('stl');
    assert.equal(glb.defaultDist, 100);
    assert.equal(stl.defaultDist, 100);
    near(glb.camera.position.z, 100);
    near(stl.camera.position.z, 100);
  });

  test('resetAll refits both panes and drops nothing from either scene', async () => {
    const { wb, a, glb, stl } = makeWb();
    await wb.layers.load(a);
    await wb.anatomy.load();
    const glbKids = glb.root.children.slice(), stlKids = stl.root.children.slice();
    glb.defaultDist = 1; stl.defaultDist = 1;
    wb.resetAll();
    assert.notEqual(glb.defaultDist, 1);
    assert.notEqual(stl.defaultDist, 1);
    assert.deepEqual(glb.root.children, glbKids);
    assert.deepEqual(stl.root.children, stlKids);
    assert.equal(wb.layers.featureObjects.get('a').parent.parent, stl.root);
    assert.equal(wb.anatomy.object.parent, glb.root);
  });
});

// ---------------------------------------------------------------------------
//  tick() — the frame body
// ---------------------------------------------------------------------------
describe('tick', () => {
  test('emits stats at most every 250 ms with az / el from the stl controls, stub triangles and fps 0 until the first 500 ms window', () => {
    const { wb, of, stl } = makeWb();
    applyOrientation(stl, 0.5, 1.0);
    wb.tick(0);
    assert.equal(of('stats').length, 0);
    wb.tick(250);
    wb.tick(500);
    assert.deepEqual(of('stats'), [
      { evt: 'stats', az: 29, el: 33, triangles: 0, fps: 0 },
      { evt: 'stats', az: 29, el: 33, triangles: 0, fps: 6 },   // 3 frames over the 500 ms window
    ]);
  });

  test('stats wait for 250 ms since the last emission, not 250 ms of ticks', () => {
    const { wb, of } = makeWb();
    wb.tick(0); wb.tick(100); wb.tick(200);
    assert.equal(of('stats').length, 0);
    wb.tick(250);
    assert.equal(of('stats').length, 1);
    wb.tick(400);
    assert.equal(of('stats').length, 1);
    wb.tick(500);
    assert.equal(of('stats').length, 2);
  });

  test('startTime seeds the fps window and triangles come from the renderers', () => {
    const io = stubIo({});
    const wb = createWorkbench({ adapters: headlessAdapters(), io, startTime: 1000 });
    const stats = []; wb.on('stats', (s) => stats.push(s));
    wb.panes.glb.renderer.info.render.triangles = 1200;
    wb.panes.stl.renderer.info.render.triangles = 34;
    wb.tick(1000); wb.tick(1250);
    assert.equal(stats.at(-1).fps, 0);
    assert.equal(stats.at(-1).triangles, 1234);
    wb.tick(1500);
    assert.equal(stats.at(-1).fps, 6);
    wb.tick(2000);   // one frame in a 500 ms window
    assert.equal(stats.at(-1).fps, 2);
  });

  test('updates both controls, renders both panes and moves the headlight with the glb camera', () => {
    const { wb, glb, stl } = makeWb();
    const glbRender = mock.method(glb.renderer, 'render'), stlRender = mock.method(stl.renderer, 'render');
    const glbUpdate = mock.method(glb.controls, 'update'), stlUpdate = mock.method(stl.controls, 'update');
    applyOrientation(glb, 0.9, 1.3);
    glbUpdate.mock.resetCalls(); stlUpdate.mock.resetCalls();
    glb.controls.target.set(3, 4, 5);
    wb.tick(16);
    assert.equal(glbRender.mock.callCount(), 1);
    assert.equal(stlRender.mock.callCount(), 1);
    assert.equal(glbRender.mock.calls[0].arguments[0], glb.scene);
    assert.equal(glbUpdate.mock.callCount(), 1);
    assert.equal(stlUpdate.mock.callCount(), 1);
    assert.ok(glb.headLight.position.equals(glb.camera.position));
    assert.ok(glb.headLight.target.position.equals(glb.controls.target));
  });
});

// ---------------------------------------------------------------------------
//  state()
// ---------------------------------------------------------------------------
describe('state()', () => {
  test('returns exactly the documented keys, deep-frozen, as a copy', async () => {
    const { wb, a } = makeWb();
    await wb.layers.load(a);
    wb.setRenderMode('slices'); wb.setSync(true); wb.setGrid(true); wb.setClipPos('x', 0.3);
    const s = wb.state();
    assert.deepEqual(Object.keys(s), STATE_KEYS);
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.clipState));
    assert.ok(Object.isFrozen(s.clipState.x));
    assert.deepEqual(s, {
      renderMode: 'slices', layout: 'split', globalOpacity: 1, autoRotate: false, linkOffsets: false,
      solidFill: false, grid: true, sync: true,
      clipState: { x: { on: true, pos: 0.3 }, y: { on: false, pos: 0.5 }, z: { on: false, pos: 0.5 }, flip: false, showPlanes: true },
    });
    assert.notEqual(wb.state(), s);
    assert.notEqual(wb.state().clipState, s.clipState);
  });

  test('mutating the returned clipState throws and leaves the workbench untouched', () => {
    const { wb, stl } = makeWb();
    const s = wb.state();
    assert.throws(() => { s.clipState.x.on = true; }, TypeError);
    assert.throws(() => { s.clipState.flip = true; }, TypeError);
    assert.throws(() => { s.renderMode = 'slices'; }, TypeError);
    assert.throws(() => { s.sync = true; }, TypeError);
    assert.equal(wb.state().clipState.x.on, false);
    assert.equal(wb.state().clipState.flip, false);
    assert.equal(wb.state().renderMode, 'surface');
    assert.equal(wb.sync.enabled, false);
    assert.equal(stl.activeClips.length, 0);
  });
});

// ---------------------------------------------------------------------------
//  resize / dispose / emitter surface
// ---------------------------------------------------------------------------
describe('resize / dispose / on-off-once', () => {
  test('resize forwards to the named pane', () => {
    const { wb, glb, stl } = makeWb();
    const setSize = mock.method(stl.renderer, 'setSize');
    wb.resize('stl', 200, 400);
    assert.deepEqual(setSize.mock.calls[0].arguments, [200, 400, false]);
    near(stl.camera.aspect, 0.5);
    near(glb.camera.aspect, 1);
  });

  test('dispose unlinks the sync, aborts in-flight loads and disposes both panes', async () => {
    const { wb, of, a, glb, stl } = makeWb({ extraEvents: ['layer:state', 'anatomy:status'], progressTicks: 4 });
    const glbDispose = mock.method(glb, 'dispose'), stlDispose = mock.method(stl, 'dispose');
    wb.setSync(true);
    const layerLoad = wb.layers.load(a);
    const anatomyLoad = wb.anatomy.load();
    assert.equal(wb.layers.inFlight.size, 1);
    assert.equal(wb.anatomy.loading, true);

    wb.dispose();
    assert.equal(wb.sync.enabled, false);
    assert.equal(glbDispose.mock.callCount(), 1);
    assert.equal(stlDispose.mock.callCount(), 1);
    await Promise.all([layerLoad, anatomyLoad]);
    assert.deepEqual(of('layer:state').map((e) => e.state), ['loading', 'idle']);
    assert.equal(of('anatomy:status').at(-1).state, 'idle');
    assert.equal(wb.layers.has('a'), false);
    assert.equal(wb.anatomy.object, null);
  });

  test('on returns an unsubscribe, off removes, once fires a single time', () => {
    const { wb } = makeWb();
    let n = 0;
    const off = wb.on('grid', () => n++);
    wb.setGrid(true);
    off();
    wb.setGrid(false);
    assert.equal(n, 1);

    const fn = () => n++;
    wb.on('grid', fn); wb.off('grid', fn);
    wb.setGrid(true);
    assert.equal(n, 1);

    wb.once('grid', fn);
    wb.setGrid(false); wb.setGrid(true);
    assert.equal(n, 2);
  });
});
