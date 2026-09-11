// ============================================================================
//  Tests for core/anatomy.js — AnatomyController running headless: model
//  switching (abort / dispose / reset / anatomy:model before load), load()'s
//  event sequence and scene-graph result, structure matching by node name or
//  named ancestor, the opaque / translucent styling rules and back-mesh render
//  orders, presets, pane-level opacity / visibility / offset, placement in
//  split vs overlay, cancel() (one idle, never two), focusBox and the read-only
//  accessors. Models come from uncompressed glbWithNodes fixtures and bytes
//  from stubIo; nothing here touches a DOM.
// ============================================================================

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AnatomyController, ANATOMY_VIEW_DIR } from '../../core/anatomy.js';
import { ANATOMY_MODELS, modelById } from '../../core/anatomy-models.js';
import { LayerController } from '../../core/layers.js';
import { createPane } from '../../core/pane.js';
import { headlessAdapters } from '../../core/adapters-headless.js';
import { createEmitter } from '../../core/emitter.js';
import { createClipState } from '../../core/clipping.js';
import { createLoaders, createMeshParsers } from '../../core/mesh-parsers.js';
import { OVERLAY_TARGET } from '../../core/framing.js';
import { glbWithNodes, stubIo } from '../helpers/fixtures.js';

const EPS = 1e-6;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, msg ?? `${a} !~ ${b}`);

// ---------------------------------------------------------------------------
//  Harness
// ---------------------------------------------------------------------------
const MESHEYE_URL = modelById('mesheye').url;
const UPAT_URL = modelById('upat').url;
const CUSTOM_URL = 'custom/eye.glb';
const MESHEYE_KEYS = ['sclera', 'choroid', 'retina', 'cornea', 'lens'];
const UPAT_KEYS = ['globe', 'pupil', 'lateral_rectus'];

function makeView(over = {}) {
  return {
    renderMode: 'surface', layout: 'split', globalOpacity: 1, autoRotate: false,
    linkOffsets: false, solidFill: false, clipState: createClipState(), ...over,
  };
}

const ANATOMY_EVENTS = ['anatomy:model', 'anatomy:status', 'anatomy:parts', 'anatomy:preset', 'anatomy:style', 'anatomy:opacity', 'anatomy:visible', 'anatomy:offset'];

/**
 * An AnatomyController over a headless glb + stl pane pair with a recording
 * emitter. Routes default to a five-structure mesh.eye, a three-structure
 * upat model and a custom model whose node names match nothing.
 */
function makeCtx({ view: viewOver = {}, routes = null, options = {}, progressTicks = 2 } = {}) {
  const glb = createPane({ id: 'glb', headLight: true, adapters: headlessAdapters() });
  const stl = createPane({ id: 'stl', capsEnabled: true, adapters: headlessAdapters() });
  const view = makeView(viewOver);
  const io = stubIo(routes ?? {
    [MESHEYE_URL]: glbWithNodes(MESHEYE_KEYS),
    [UPAT_URL]: glbWithNodes(UPAT_KEYS),
    [CUSTOM_URL]: glbWithNodes(['foo', 'bar']),
    progressTicks,
  });
  const parsers = createMeshParsers(createLoaders());
  const emitter = createEmitter();
  const events = [];
  for (const evt of ANATOMY_EVENTS) emitter.on(evt, (payload) => events.push({ evt, ...payload }));
  const layers = new LayerController({ pane: stl, view, io, parsers, emitter });
  const anatomy = new AnatomyController({ panes: { glb, stl }, view, layers, io, parsers, emitter }, options);
  const of = (evt) => events.filter((e) => e.evt === evt);
  const statuses = () => of('anatomy:status').map((e) => `${e.state}${e.phase ? '/' + e.phase : ''}`);
  return { glb, stl, view, io, emitter, events, of, statuses, layers, anatomy };
}

// Resolves once the controller has emitted `n` anatomy:status download ticks.
function afterDownloadTick(ctx, n = 1) {
  return new Promise((resolve) => {
    const seen = () => ctx.of('anatomy:status').filter((e) => e.phase === 'download').length >= n;
    if (seen()) return resolve();
    const off = ctx.emitter.on('anatomy:status', () => { if (seen()) { off(); resolve(); } });
  });
}

const meshes = (obj) => { const out = []; obj.traverse((c) => { if (c.isMesh && !c.userData.anatomyBackOf) out.push(c); }); return out; };
const quiet = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); };

// ---------------------------------------------------------------------------
//  Construction, model resolution and URL
// ---------------------------------------------------------------------------
describe('construction', () => {
  test('defaults to mesheye with empty parts, whole preset, opacity 1, zero offset, not loading', () => {
    const { anatomy, glb, stl } = makeCtx();
    assert.equal(anatomy.modelId(), 'mesheye');
    assert.equal(anatomy.model(), ANATOMY_MODELS[0]);
    assert.equal(anatomy.url(), MESHEYE_URL);
    assert.equal(anatomy.object, null);
    assert.ok(anatomy.group instanceof THREE.Group);
    assert.equal(anatomy.group.parent, null);
    assert.equal(anatomy.parts.size, 0);
    assert.equal(anatomy.preset, 'whole');
    assert.equal(anatomy.opacity, 1);
    assert.deepEqual(anatomy.offset, { x: 0, y: 0, z: 0 });
    assert.equal(anatomy.loading, false);
    assert.deepEqual(anatomy.structures(), []);
    assert.equal(anatomy.presets(), modelById('mesheye').presets);
    assert.equal(glb.root.children.length, 0);
    assert.equal(stl.root.children.length, 0);
  });

  test('modelId option goes through resolveModelId: available ids honoured, unknown / unavailable fall back', () => {
    assert.equal(makeCtx({ options: { modelId: 'upat' } }).anatomy.modelId(), 'upat');
    assert.equal(makeCtx({ options: { modelId: 'isetbio' } }).anatomy.modelId(), 'mesheye');
    assert.equal(makeCtx({ options: { modelId: 'nope' } }).anatomy.modelId(), 'mesheye');
    assert.equal(makeCtx({ options: { modelId: null } }).anatomy.modelId(), 'mesheye');
    assert.equal(makeCtx({ options: {} }).anatomy.modelId(), 'mesheye');
  });

  test('url() honours anatomyUrl over the model file, and follows the model when unset', async () => {
    const custom = makeCtx({ options: { anatomyUrl: CUSTOM_URL, modelId: 'upat' } });
    assert.equal(custom.anatomy.url(), CUSTOM_URL);
    assert.equal(custom.anatomy.modelId(), 'upat');
    const plain = makeCtx({ options: { anatomyUrl: '' } });
    assert.equal(plain.anatomy.url(), MESHEYE_URL);
    await plain.anatomy.setModel('upat');
    assert.equal(plain.anatomy.url(), UPAT_URL);
  });

  test('meta / stateFor: registry metadata for a known key, a white opaque default for an unknown one', () => {
    const { anatomy } = makeCtx();
    assert.equal(anatomy.meta('cornea').depth, 0);
    assert.equal(anatomy.meta('nope'), undefined);
    const st = anatomy.stateFor('cornea');
    assert.deepEqual(st, { visible: true, color: 0xd6edf5, opacity: 0.15 });
    assert.equal(anatomy.stateFor('cornea'), st, 'same object on the second call');
    assert.deepEqual(anatomy.stateFor('mystery'), { visible: true, color: 0xffffff, opacity: 1 });
  });
});

// ---------------------------------------------------------------------------
//  load()
// ---------------------------------------------------------------------------
describe('load()', () => {
  test('emits loading/start → download ×2 → loading/build → anatomy:parts → loaded', async () => {
    const ctx = makeCtx();
    await ctx.anatomy.load();
    assert.deepEqual(ctx.statuses(), ['loading/start', 'loading/download', 'loading/download', 'loading/build', 'loaded']);
    const seq = ctx.events.map((e) => e.evt);
    assert.equal(seq.indexOf('anatomy:parts'), seq.length - 2, 'anatomy:parts is emitted right before loaded');
    assert.equal(seq.at(-1), 'anatomy:status');

    const start = ctx.of('anatomy:status')[0];
    assert.deepEqual(start, { evt: 'anatomy:status', state: 'loading', phase: 'start', pct: 0 });
    const d1 = ctx.of('anatomy:status')[1];
    const total = glbWithNodes(MESHEYE_KEYS).byteLength;
    assert.deepEqual(d1, { evt: 'anatomy:status', state: 'loading', phase: 'download', pct: 50, loaded: Math.round(total / 2), total, fromCache: false });
    assert.equal(ctx.of('anatomy:status')[2].pct, 100);
    assert.deepEqual(ctx.of('anatomy:status')[3], { evt: 'anatomy:status', state: 'loading', phase: 'build', pct: 100 });
    assert.deepEqual(ctx.of('anatomy:status').at(-1), { evt: 'anatomy:status', state: 'loaded' });

    const parts = ctx.of('anatomy:parts')[0];
    assert.deepEqual(parts, { evt: 'anatomy:parts', modelId: 'mesheye', keys: MESHEYE_KEYS, unmatched: [], preset: 'whole' });
    assert.equal(ctx.io.calls[0].url, MESHEYE_URL);
  });

  test('a cached URL reports one download tick with fromCache and pct 100', async () => {
    const ctx = makeCtx({ routes: { [MESHEYE_URL]: glbWithNodes(MESHEYE_KEYS), cached: [MESHEYE_URL] } });
    await ctx.anatomy.load();
    assert.deepEqual(ctx.statuses(), ['loading/start', 'loading/download', 'loading/build', 'loaded']);
    const d = ctx.of('anatomy:status')[1];
    assert.equal(d.fromCache, true);
    assert.equal(d.pct, 100);
    assert.equal(d.loaded, d.total);
  });

  test('places the object under glb.root in split, framed along ANATOMY_VIEW_DIR, and registers five parts', async () => {
    const { anatomy, glb, stl } = makeCtx();
    await anatomy.load();
    assert.ok(anatomy.object);
    assert.equal(anatomy.object.parent, glb.root);
    assert.equal(glb.root.children.length, 1);
    assert.equal(stl.root.children.length, 0);
    assert.equal(anatomy.group.parent, null);
    assert.equal(anatomy.parts.size, 5);
    assert.deepEqual([...anatomy.parts.keys()], MESHEYE_KEYS);
    for (const key of MESHEYE_KEYS) {
      const mesh = anatomy.parts.get(key);
      assert.ok(mesh.isMesh);
      assert.equal(mesh.userData.anatomyKey, key);
    }
    assert.deepEqual(anatomy.structures().map((s) => s.key), MESHEYE_KEYS, 'registry order, matched only');

    // Camera sits along the view direction from the focus box centre.
    const dir = glb.camera.position.clone().sub(glb.controls.target).normalize();
    const want = ANATOMY_VIEW_DIR.clone().normalize();
    near(dir.x, want.x); near(dir.y, want.y); near(dir.z, want.z);
    assert.ok(glb.defaultDist > 0);
    assert.equal(glb.bounds.isEmpty(), false);
    assert.equal(anatomy.loading, false);
  });

  test('a no-parts model keeps zero parts, applies the pane opacity to every mesh and reports keys []', async (t) => {
    quiet(t);
    const ctx = makeCtx({ options: { anatomyUrl: CUSTOM_URL } });
    ctx.anatomy.setPaneOpacity(0.5);
    await ctx.anatomy.load();
    assert.equal(ctx.anatomy.parts.size, 0);
    assert.deepEqual(ctx.anatomy.structures(), []);
    const parts = ctx.of('anatomy:parts')[0];
    assert.deepEqual(parts.keys, []);
    assert.deepEqual(parts.unmatched.slice().sort(), ['bar', 'foo']);
    assert.equal(parts.modelId, 'mesheye');
    const ms = meshes(ctx.anatomy.object);
    assert.equal(ms.length, 2);
    for (const m of ms) { near(m.material.opacity, 0.5); assert.equal(m.material.transparent, true); assert.equal(m.renderOrder, 1); }
    assert.equal(ctx.anatomy.object.parent, ctx.glb.root);
    assert.equal(ctx.statuses().at(-1), 'loaded');
    assert.equal(console.warn.mock.callCount(), 1);
  });

  test('a failed fetch emits anatomy:status error with the message, never rejects, and clears loading', async (t) => {
    quiet(t);
    const ctx = makeCtx({ routes: {} });
    await assert.doesNotReject(() => ctx.anatomy.load());
    assert.deepEqual(ctx.statuses(), ['loading/start', 'error']);
    assert.equal(ctx.of('anatomy:status').at(-1).message, 'HTTP 404 Not Found');
    assert.equal(ctx.anatomy.object, null);
    assert.equal(ctx.anatomy.loading, false);
    assert.equal(ctx.of('anatomy:parts').length, 0);
  });

  test('loading flips true while the download is in flight and false afterwards', async () => {
    const ctx = makeCtx();
    assert.equal(ctx.anatomy.loading, false);
    const p = ctx.anatomy.load();
    assert.equal(ctx.anatomy.loading, true);
    assert.equal(ctx.anatomy.state().loading, true);
    await afterDownloadTick(ctx);
    assert.equal(ctx.anatomy.loading, true);
    await p;
    assert.equal(ctx.anatomy.loading, false);
  });
});

// ---------------------------------------------------------------------------
//  cancel()
// ---------------------------------------------------------------------------
describe('cancel()', () => {
  test('mid-download → exactly one anatomy:status idle, no error, no parts, promise resolves', async () => {
    const ctx = makeCtx({ progressTicks: 4 });
    const p = ctx.anatomy.load();
    await afterDownloadTick(ctx, 1);
    ctx.anatomy.cancel();
    await p;
    const s = ctx.statuses();
    assert.equal(s.filter((x) => x === 'idle').length, 1);
    assert.equal(s.at(-1), 'idle');
    assert.equal(s.includes('error'), false);
    assert.equal(s.includes('loaded'), false);
    assert.equal(ctx.of('anatomy:parts').length, 0);
    assert.equal(ctx.anatomy.object, null);
    assert.equal(ctx.anatomy.loading, false);
    assert.ok(s.filter((x) => x === 'loading/download').length < 4, 'the download did not run to completion');
  });

  test('when nothing is loading, cancel() emits nothing and does not throw', () => {
    const ctx = makeCtx();
    assert.doesNotThrow(() => ctx.anatomy.cancel());
    assert.equal(ctx.events.length, 0);
  });

  test('cancel() after a completed load emits nothing', async () => {
    const ctx = makeCtx();
    await ctx.anatomy.load();
    const n = ctx.events.length;
    ctx.anatomy.cancel();
    assert.equal(ctx.events.length, n);
  });
});

// ---------------------------------------------------------------------------
//  setModel()
// ---------------------------------------------------------------------------
describe('setModel()', () => {
  test("setModel('upat') disposes, clears parts / state / preset / glb.root, emits anatomy:model THEN loads", async () => {
    const ctx = makeCtx();
    const { anatomy, glb } = ctx;
    await anatomy.load();
    anatomy.setPreset('coats');
    const old = anatomy.object;
    const disposed = [];
    old.traverse((c) => { if (c.isMesh) c.geometry.dispose = () => disposed.push(c); });
    ctx.events.length = 0;

    const p = anatomy.setModel('upat');
    // Synchronous part: state reset and the model event, before any download tick.
    assert.equal(anatomy.modelId(), 'upat');
    assert.equal(anatomy.object, null);
    assert.equal(anatomy.parts.size, 0);
    assert.equal(anatomy.preset, 'whole');
    assert.equal(anatomy.stateMap.size, 0);
    assert.equal(glb.root.children.length, 0);
    assert.equal(old.parent, null);
    assert.ok(disposed.length >= 5, 'the old geometry was disposed');
    assert.deepEqual(ctx.events[0], { evt: 'anatomy:model', id: 'upat', model: modelById('upat'), isDefault: false, preset: 'whole' });
    assert.equal(ctx.events[1].evt, 'anatomy:status');
    assert.equal(ctx.events[1].phase, 'start');
    assert.equal(ctx.io.calls.at(-1).url, UPAT_URL);

    await p;
    assert.deepEqual([...anatomy.parts.keys()], UPAT_KEYS);
    assert.equal(anatomy.object.parent, glb.root);
    assert.deepEqual(ctx.of('anatomy:parts').at(-1).keys, UPAT_KEYS);
    assert.equal(ctx.of('anatomy:parts').at(-1).preset, 'whole');
    assert.equal(ctx.statuses().at(-1), 'loaded');
    // The upat globe is styled from its own registry entry.
    assert.equal(anatomy.parts.get('globe').material.color.getHex(), 0xc6c0b2);
    assert.equal(anatomy.stateFor('pupil').color, 0x2b2f36);
  });

  test('switching back to the default reports isDefault true', async () => {
    const ctx = makeCtx({ options: { modelId: 'upat' } });
    await ctx.anatomy.setModel('mesheye');
    assert.deepEqual(ctx.of('anatomy:model')[0], { evt: 'anatomy:model', id: 'mesheye', model: modelById('mesheye'), isDefault: true, preset: 'whole' });
    assert.equal(ctx.anatomy.parts.size, 5);
  });

  test('switching mid-download aborts the old load: exactly one idle, then the new model lands', async () => {
    const ctx = makeCtx({ progressTicks: 4 });
    const p1 = ctx.anatomy.load();
    await afterDownloadTick(ctx, 1);
    const p2 = ctx.anatomy.setModel('upat');
    await Promise.all([p1, p2]);
    const s = ctx.statuses();
    assert.equal(s.filter((x) => x === 'idle').length, 1);
    assert.equal(s.filter((x) => x === 'loaded').length, 1);
    assert.equal(s.includes('error'), false);
    assert.deepEqual([...ctx.anatomy.parts.keys()], UPAT_KEYS);
    assert.equal(ctx.anatomy.object.parent, ctx.glb.root);
    assert.equal(ctx.glb.root.children.length, 1);
  });

  test('an unavailable id or the current id emits nothing and fetches nothing', async () => {
    const ctx = makeCtx();
    await ctx.anatomy.setModel('isetbio');
    await ctx.anatomy.setModel('nope');
    await ctx.anatomy.setModel('mesheye');
    assert.equal(ctx.events.length, 0);
    assert.equal(ctx.io.calls.length, 0);
    assert.equal(ctx.anatomy.modelId(), 'mesheye');
  });
});

// ---------------------------------------------------------------------------
//  registerParts()
// ---------------------------------------------------------------------------
describe('registerParts()', () => {
  test('matches the mesh name or the nearest named ancestor, case- and whitespace-insensitively, and reports the rest', async (t) => {
    quiet(t);
    const { anatomy } = makeCtx();
    const scene = new THREE.Group();
    const direct = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); direct.name = ' SCLERA ';
    const holder = new THREE.Group(); holder.name = 'Retina';
    const inner = new THREE.Group();                       // unnamed intermediate
    const viaAncestor = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    inner.add(viaAncestor); holder.add(inner);
    const stray = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); stray.name = 'Stray';
    const nameless = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    scene.add(direct, holder, stray, nameless);

    const { keys, unmatched } = anatomy.registerParts(scene);
    assert.deepEqual(keys, ['sclera', 'retina']);
    assert.deepEqual(unmatched, ['Stray', '(unnamed)']);
    assert.equal(anatomy.parts.get('sclera'), direct);
    assert.equal(anatomy.parts.get('retina'), viaAncestor);
    assert.equal(viaAncestor.userData.anatomyKey, 'retina');
    assert.equal(console.warn.mock.callCount(), 1);
    // Matched meshes are styled: their original material is swapped for the anatomy one.
    assert.equal(direct.material.userData.anatomy, true);
    assert.equal(direct.material.color.getHex(), 0xc6c0b2);
    // The generated back-face meshes are not re-registered on a second pass.
    const again = anatomy.registerParts(scene);
    assert.deepEqual(again.keys, ['sclera', 'retina']);
    assert.deepEqual(again.unmatched, ['Stray', '(unnamed)']);
  });
});

// ---------------------------------------------------------------------------
//  Styling
// ---------------------------------------------------------------------------
describe('applyStyle()', () => {
  test('opaque structures depth-test normally with a hidden back mesh; translucent ones split front / back with depth-ordered renderOrder', async () => {
    const { anatomy } = makeCtx();
    await anatomy.load();

    const sclera = anatomy.parts.get('sclera');       // opacity 1, depth 0
    assert.equal(sclera.material.userData.anatomy, true);
    assert.equal(sclera.material.color.getHex(), 0xc6c0b2);
    near(sclera.material.roughness, 0.52);
    assert.equal(sclera.material.transparent, false);
    assert.equal(sclera.material.depthWrite, true);
    assert.equal(sclera.material.side, THREE.DoubleSide);
    assert.equal(sclera.renderOrder, 0);
    assert.equal(sclera.visible, true);
    const scleraBack = sclera.userData.backMesh;
    assert.ok(scleraBack.isMesh);
    assert.equal(scleraBack.parent, sclera);
    assert.equal(scleraBack.geometry, sclera.geometry);
    assert.equal(scleraBack.userData.anatomyBackOf, 'sclera');
    assert.equal(scleraBack.visible, false);
    assert.equal(scleraBack.renderOrder, 10);
    assert.equal(scleraBack.material.side, THREE.BackSide);
    assert.equal(scleraBack.frustumCulled, false);

    const cornea = anatomy.parts.get('cornea');       // opacity 0.15, depth 0
    near(cornea.material.opacity, 0.15);
    assert.equal(cornea.material.transparent, true);
    assert.equal(cornea.material.depthWrite, false);
    assert.equal(cornea.material.side, THREE.FrontSide);
    assert.equal(cornea.renderOrder, 90);
    assert.equal(cornea.userData.backMesh.visible, true);
    assert.equal(cornea.userData.backMesh.renderOrder, 10);
    near(cornea.userData.backMesh.material.opacity, 0.15);
    assert.equal(cornea.userData.backMesh.material.depthWrite, false);
    assert.equal(cornea.userData.backMesh.material.transparent, true);

    const lens = anatomy.parts.get('lens');           // opacity 0.82, depth 3
    assert.equal(lens.renderOrder, 87);
    assert.equal(lens.userData.backMesh.renderOrder, 13);
    assert.equal(lens.userData.backMesh.visible, true);

    // Restyling reuses the same material and back mesh.
    const mat = sclera.material, back = sclera.userData.backMesh;
    anatomy.applyStyleAll();
    assert.equal(sclera.material, mat);
    assert.equal(sclera.userData.backMesh, back);
    assert.equal(sclera.children.filter((c) => c.userData.anatomyBackOf).length, 1);
  });

  test('applyStyle on an unregistered key is a no-op', async () => {
    const { anatomy } = makeCtx();
    assert.doesNotThrow(() => anatomy.applyStyle('sclera'));
    assert.equal(anatomy.stateMap.size, 0);
  });

  test('setVisible / setColor / setOpacity mutate the state, restyle the mesh and emit anatomy:style', async () => {
    const ctx = makeCtx();
    const { anatomy } = ctx;
    await anatomy.load();
    ctx.events.length = 0;

    anatomy.setVisible('sclera', false);
    assert.equal(anatomy.parts.get('sclera').visible, false);
    assert.equal(anatomy.stateFor('sclera').visible, false);
    assert.deepEqual(ctx.events.at(-1), { evt: 'anatomy:style', key: 'sclera', state: { visible: false, color: 0xc6c0b2, opacity: 1 } });

    anatomy.setColor('retina', 0x123456);
    assert.equal(anatomy.parts.get('retina').material.color.getHex(), 0x123456);
    assert.equal(anatomy.parts.get('retina').userData.backMesh.material.color.getHex(), 0x123456);
    assert.deepEqual(ctx.events.at(-1), { evt: 'anatomy:style', key: 'retina', state: { visible: true, color: 0x123456, opacity: 1 } });

    anatomy.setOpacity('choroid', 0.4);
    const choroid = anatomy.parts.get('choroid');
    near(choroid.material.opacity, 0.4);
    assert.equal(choroid.material.transparent, true);
    assert.equal(choroid.renderOrder, 89);
    assert.equal(choroid.userData.backMesh.visible, true);
    assert.equal(choroid.userData.backMesh.renderOrder, 11);
    assert.deepEqual(ctx.events.at(-1), { evt: 'anatomy:style', key: 'choroid', state: { visible: true, color: 0x8e2b3c, opacity: 0.4 } });

    // The emitted state is a snapshot, not the live record.
    ctx.events.at(-1).state.opacity = 0;
    assert.equal(anatomy.stateFor('choroid').opacity, 0.4);
    assert.equal(ctx.of('anatomy:style').length, 3);
  });
});

// ---------------------------------------------------------------------------
//  Presets
// ---------------------------------------------------------------------------
describe('setPreset()', () => {
  test("'coats' hides the media, fades the sclera / choroid, emits one anatomy:style per structure then anatomy:preset", async () => {
    const ctx = makeCtx();
    const { anatomy } = ctx;
    await anatomy.load();
    ctx.events.length = 0;

    anatomy.setPreset('coats');
    assert.equal(anatomy.preset, 'coats');
    const coats = modelById('mesheye').presets.coats;
    for (const key of ['cornea', 'lens']) {
      assert.equal(anatomy.stateFor(key).visible, false);
      assert.equal(anatomy.parts.get(key).visible, false);
    }
    for (const key of ['sclera', 'choroid', 'retina']) assert.equal(anatomy.parts.get(key).visible, true);
    near(anatomy.stateFor('sclera').opacity, 0.26);
    near(anatomy.parts.get('sclera').material.opacity, 0.26);
    assert.equal(anatomy.parts.get('sclera').material.transparent, true);
    assert.equal(anatomy.parts.get('sclera').renderOrder, 90);
    assert.equal(anatomy.parts.get('sclera').userData.backMesh.visible, true);
    near(anatomy.stateFor('choroid').opacity, 0.62);
    near(anatomy.stateFor('retina').opacity, 1);
    assert.equal(anatomy.parts.get('retina').material.transparent, false);
    // Structures the fixture lacks still get their state set (rows read it).
    assert.equal(anatomy.stateFor('vitreous').visible, false);
    near(anatomy.stateFor('optic_nerve').opacity, 1);

    const structures = modelById('mesheye').structures;
    const styles = ctx.of('anatomy:style');
    assert.equal(styles.length, structures.length);
    assert.deepEqual(styles.map((e) => e.key), structures.map((s) => s.key));
    assert.equal(styles.find((e) => e.key === 'cornea').state.visible, false);
    const seq = ctx.events.map((e) => e.evt);
    assert.equal(seq.at(-1), 'anatomy:preset', 'the preset event comes after every style event');
    assert.deepEqual(ctx.of('anatomy:preset')[0], { evt: 'anatomy:preset', name: 'coats', preset: coats });
  });

  test("'whole' restores the registry defaults", async () => {
    const { anatomy } = makeCtx();
    await anatomy.load();
    anatomy.setPreset('coats');
    anatomy.setPreset('whole');
    assert.equal(anatomy.preset, 'whole');
    assert.equal(anatomy.stateFor('cornea').visible, true);
    assert.equal(anatomy.parts.get('cornea').visible, true);
    near(anatomy.stateFor('sclera').opacity, 1);
    assert.equal(anatomy.parts.get('sclera').material.transparent, false);
  });

  test("an unknown preset is a no-op: state, preset name and events untouched", async () => {
    const ctx = makeCtx();
    await ctx.anatomy.load();
    ctx.events.length = 0;
    ctx.anatomy.setPreset('nope');
    assert.equal(ctx.anatomy.preset, 'whole');
    assert.equal(ctx.events.length, 0);
    assert.equal(ctx.anatomy.stateFor('cornea').visible, true);
  });

  test('presets are read from the active model: upat has whole / muscles / recti', async () => {
    const ctx = makeCtx({ options: { modelId: 'upat' } });
    await ctx.anatomy.load();
    assert.deepEqual(Object.keys(ctx.anatomy.presets()), ['whole', 'muscles', 'recti']);
    ctx.anatomy.setPreset('muscles');
    near(ctx.anatomy.stateFor('globe').opacity, 0.22);
    near(ctx.anatomy.parts.get('globe').material.opacity, 0.22);
    assert.equal(ctx.anatomy.parts.get('globe').material.transparent, true);
    ctx.anatomy.setPreset('coats');          // a mesheye preset — not on upat
    assert.equal(ctx.anatomy.preset, 'muscles');
  });
});

// ---------------------------------------------------------------------------
//  Pane-level controls
// ---------------------------------------------------------------------------
describe('setPaneOpacity()', () => {
  test('scales every structure alpha (0.5 → sclera translucent at 0.5, cornea at 0.075) and emits anatomy:opacity', async () => {
    const ctx = makeCtx();
    const { anatomy } = ctx;
    await anatomy.load();
    ctx.events.length = 0;
    anatomy.setPaneOpacity(0.5);
    assert.equal(anatomy.opacity, 0.5);
    assert.deepEqual(ctx.events[0], { evt: 'anatomy:opacity', value: 0.5 });
    const sclera = anatomy.parts.get('sclera');
    near(sclera.material.opacity, 0.5);
    assert.equal(sclera.material.transparent, true);
    assert.equal(sclera.material.side, THREE.FrontSide);
    assert.equal(sclera.renderOrder, 90);
    assert.equal(sclera.userData.backMesh.visible, true);
    near(anatomy.parts.get('cornea').material.opacity, 0.075);
    near(anatomy.stateFor('sclera').opacity, 1, 'the per-structure state is untouched');
    assert.equal(ctx.of('anatomy:style').length, 0, 'no per-structure style events');
    anatomy.setPaneOpacity(1);
    assert.equal(sclera.material.transparent, false);
    assert.equal(sclera.renderOrder, 0);
  });

  test('with no object it only records the value and emits', () => {
    const ctx = makeCtx();
    assert.doesNotThrow(() => ctx.anatomy.setPaneOpacity(0.3));
    assert.equal(ctx.anatomy.opacity, 0.3);
    assert.equal(ctx.anatomy.state().opacity, 0.3);
    assert.deepEqual(ctx.events, [{ evt: 'anatomy:opacity', value: 0.3 }]);
  });
});

describe('setObjectVisible()', () => {
  test('flips the loaded object and emits anatomy:visible; without an object it only emits', async () => {
    const ctx = makeCtx();
    ctx.anatomy.setObjectVisible(false);
    assert.deepEqual(ctx.events, [{ evt: 'anatomy:visible', on: false }]);
    await ctx.anatomy.load();
    assert.equal(ctx.anatomy.object.visible, true, 'a later load is not retro-hidden (parity)');
    ctx.anatomy.setObjectVisible(false);
    assert.equal(ctx.anatomy.object.visible, false);
    assert.equal(ctx.anatomy.state().visible, false);
    assert.deepEqual(ctx.of('anatomy:visible').at(-1), { evt: 'anatomy:visible', on: false });
    ctx.anatomy.setObjectVisible(true);
    assert.equal(ctx.anatomy.object.visible, true);
  });
});

// ---------------------------------------------------------------------------
//  Placement and offsets
// ---------------------------------------------------------------------------
describe('place()', () => {
  test('in overlay: wraps the object in the group under stl.root, normalised, and refits the workspace at 1.7', async () => {
    const ctx = makeCtx();
    const { anatomy, glb, stl, view, layers } = ctx;
    await anatomy.load();
    const fitStl = mock.method(layers, 'fitStl');

    view.layout = 'overlay';
    anatomy.place();
    assert.equal(anatomy.object.parent, anatomy.group);
    assert.equal(anatomy.group.parent, stl.root);
    assert.equal(glb.root.children.length, 0);
    assert.equal(fitStl.mock.callCount(), 1);
    assert.deepEqual(fitStl.mock.calls[0].arguments, [1.7]);
    // glbWithNodes(5) spans 1×1×4 → the long axis is normalised to OVERLAY_TARGET and centred.
    near(anatomy.group.scale.x, OVERLAY_TARGET / 4);
    const box = new THREE.Box3().setFromObject(anatomy.group);
    const c = box.getCenter(new THREE.Vector3());
    near(c.x, 0); near(c.y, 0); near(c.z, 0);
    near(box.getSize(new THREE.Vector3()).z, OVERLAY_TARGET);
    assert.equal(stl.bounds.isEmpty(), false);
    // A second place() in overlay does not add a second group.
    anatomy.place();
    assert.equal(stl.root.children.filter((c) => c === anatomy.group).length, 1);
    assert.equal(anatomy.group.children.length, 1);
  });

  test('back to split: the group leaves stl.root and the object returns to glb.root, reframed', async () => {
    const ctx = makeCtx();
    const { anatomy, glb, stl, view } = ctx;
    await anatomy.load();
    glb.scene.updateMatrixWorld(true);
    const boxBefore = new THREE.Box3().setFromObject(anatomy.object);
    view.layout = 'overlay';
    anatomy.place();
    stl.scene.updateMatrixWorld(true);              // a rendered frame in the overlay layout
    glb.camera.position.set(999, 999, 999);
    glb.defaultDist = -1;

    view.layout = 'split';
    anatomy.place();
    assert.equal(anatomy.object.parent, glb.root);
    assert.equal(anatomy.group.parent, null);
    assert.equal(anatomy.group.children.length, 0);
    assert.equal(stl.root.children.length, 0);
    // Re-fit: the sentinel is gone, defaultDist recomputed, camera back on the anatomy view direction.
    assert.ok(glb.defaultDist > 0);
    assert.notEqual(glb.camera.position.x, 999);
    const dir = glb.camera.position.clone().sub(glb.controls.target).normalize();
    const want = ANATOMY_VIEW_DIR.clone().normalize();
    near(dir.x, want.x); near(dir.y, want.y); near(dir.z, want.z);
    // Once world matrices refresh (the next frame) the object is back at its original extent —
    // the overlay group's scale lived on the group, never on the object.
    glb.scene.updateMatrixWorld(true);
    const boxAfter = new THREE.Box3().setFromObject(anatomy.object);
    near(boxAfter.min.z, boxBefore.min.z); near(boxAfter.max.z, boxBefore.max.z);
    near(boxAfter.max.x, boxBefore.max.x);
  });

  test('with no object, place() is a no-op in either layout', () => {
    const ctx = makeCtx({ view: { layout: 'overlay' } });
    assert.doesNotThrow(() => ctx.anatomy.place());
    assert.equal(ctx.stl.root.children.length, 0);
    assert.equal(ctx.anatomy.group.parent, null);
    ctx.view.layout = 'split';
    assert.doesNotThrow(() => ctx.anatomy.place());
    assert.equal(ctx.glb.root.children.length, 0);
  });
});

describe('setOffset()', () => {
  test('records the axis, emits anatomy:offset with a copy, and re-normalises only in overlay', async () => {
    const ctx = makeCtx();
    const { anatomy, view } = ctx;
    await anatomy.load();
    ctx.events.length = 0;

    anatomy.setOffset('x', 0.4);
    assert.deepEqual(anatomy.offset, { x: 0.4, y: 0, z: 0 });
    assert.deepEqual(ctx.events, [{ evt: 'anatomy:offset', axis: 'x', value: 0.4, offset: { x: 0.4, y: 0, z: 0 } }]);
    near(anatomy.group.position.x, 0, 'split: the group is not moved');
    ctx.events[0].offset.x = 9;
    assert.equal(anatomy.offset.x, 0.4, 'the payload is a copy');

    view.layout = 'overlay';
    anatomy.place();
    const box = new THREE.Box3().setFromObject(anatomy.group);
    near(box.getCenter(new THREE.Vector3()).x, 0.4 * OVERLAY_TARGET, 'placement honours the stored offset');

    anatomy.setOffset('y', -0.2);
    const box2 = new THREE.Box3().setFromObject(anatomy.group);
    const c2 = box2.getCenter(new THREE.Vector3());
    near(c2.x, 0.4 * OVERLAY_TARGET); near(c2.y, -0.2 * OVERLAY_TARGET); near(c2.z, 0);
    assert.deepEqual(ctx.of('anatomy:offset').at(-1).offset, { x: 0.4, y: -0.2, z: 0 });
    assert.equal(ctx.stl.bounds.isEmpty(), false);
  });
});

// ---------------------------------------------------------------------------
//  focusBox() and accessors
// ---------------------------------------------------------------------------
describe('focusBox()', () => {
  test('uses the sclera when visible, the whole object when the sclera is hidden, and is empty with nothing loaded', async () => {
    const { anatomy } = makeCtx();
    assert.equal(anatomy.focusBox().isEmpty(), true);
    await anatomy.load();
    // Fixture node i sits at z = i; the sclera is node 0.
    const onSclera = anatomy.focusBox();
    near(onSclera.min.z, 0); near(onSclera.max.z, 0);
    anatomy.setVisible('sclera', false);
    const whole = anatomy.focusBox();
    near(whole.min.z, 0); near(whole.max.z, 4);
  });

  test('a model without a sclera (upat) frames the whole object — the hard-coded key is preserved', async () => {
    const { anatomy } = makeCtx({ options: { modelId: 'upat' } });
    await anatomy.load();
    assert.equal(anatomy.parts.has('globe'), true);
    assert.equal(anatomy.parts.has('sclera'), false);
    near(anatomy.focusBox().max.z, 2);
  });
});

describe('accessors', () => {
  test('preset / parts / object / offset / loading / state() after a load', async () => {
    const { anatomy, glb } = makeCtx();
    await anatomy.load();
    assert.equal(anatomy.preset, 'whole');
    assert.equal(anatomy.parts.size, 5);
    assert.equal(anatomy.object.parent, glb.root);
    assert.equal(anatomy.loading, false);

    const off = anatomy.offset;
    off.x = 0.9;
    assert.equal(anatomy.offset.x, 0, 'offset is a copy');
    near(anatomy.group.position.x, 0, 'mutating the copy does not move the group');

    const s = anatomy.state();
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.offset));
    assert.ok(Object.isFrozen(s.partKeys));
    assert.deepEqual(s, {
      modelId: 'mesheye', url: MESHEYE_URL, preset: 'whole', opacity: 1,
      offset: { x: 0, y: 0, z: 0 }, visible: true, partKeys: MESHEYE_KEYS, loading: false,
    });
    assert.throws(() => { 'use strict'; s.preset = 'coats'; }, TypeError);
    assert.equal(anatomy.preset, 'whole');
    // state() is a fresh snapshot each call.
    anatomy.setPreset('coats');
    assert.equal(anatomy.state().preset, 'coats');
    assert.equal(s.preset, 'whole');
  });

  test('parts is the live map — it empties on setModel and refills after the load', async () => {
    const { anatomy } = makeCtx();
    const live = anatomy.parts;
    await anatomy.load();
    assert.equal(live.size, 5);
    const p = anatomy.setModel('upat');
    assert.equal(live.size, 0);
    await p;
    assert.equal(live.size, 3);
    assert.equal(anatomy.parts, live);
  });
});
