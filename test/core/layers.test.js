// ============================================================================
//  Tests for core/layers.js — LayerController running headless: load()'s event
//  sequence and scene-graph result, abort / failure paths (one idle, never
//  two), visibility syncing with and without an object, the sample offset /
//  opacity rules and their sample:offset events, the empty-samples default,
//  the solid-fill reload cycle, framing, and the pure solidVariant /
//  effectivePath / isHeavy rules. Meshes come from the in-memory fixtures and
//  bytes from stubIo; nothing here touches a DOM.
// ============================================================================

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LayerController, HEAVY_BYTES, solidVariant, effectivePath } from '../../core/layers.js';
import { createPane } from '../../core/pane.js';
import { headlessAdapters } from '../../core/adapters-headless.js';
import { createEmitter } from '../../core/emitter.js';
import { createClipState } from '../../core/clipping.js';
import { createLoaders, createMeshParsers } from '../../core/mesh-parsers.js';
import { fitDistance, OVERLAY_TARGET } from '../../core/framing.js';
import { binarySTL, glbWithNodes, stubIo } from '../helpers/fixtures.js';

const EPS = 1e-6;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, msg ?? `${a} !~ ${b}`);

// ---------------------------------------------------------------------------
//  Harness
// ---------------------------------------------------------------------------
const F10_PATH = 'https://hf.example/resolve/main/F10_layers/retina.glb';
const F10_SOLID = 'optimized/F10_layers_solid/retina.glb';

function makeView(over = {}) {
  return {
    renderMode: 'surface', layout: 'split', globalOpacity: 1, autoRotate: false,
    linkOffsets: false, solidFill: false, clipState: createClipState(), ...over,
  };
}

// A data-loader-shaped structure record.
function structure(id, sampleId, over = {}) {
  return { id, sampleId, label: id.toUpperCase(), kind: 'stl', path: `${id}.stl`, color: 0xff0000, opacity: 1, bytes: null, ...over };
}
// A data-loader-shaped sample record.
function sample(id, structures, over = {}) {
  return { id, label: id.toUpperCase(), offset: { x: 0, y: 0, z: 0 }, opacity: 1, structures, ...over };
}

/**
 * A LayerController on a headless stl pane with a recording emitter. Routes
 * default to two STL layers per sample for samples s1 / s2, plus an F10 coat
 * (and its solid variant) as GLB.
 */
function makeCtx({ view: viewOver = {}, routes = null, samples = null, progressTicks = 2 } = {}) {
  const pane = createPane({ id: 'stl', capsEnabled: true, adapters: headlessAdapters() });
  const view = makeView(viewOver);
  const io = stubIo(routes ?? {
    'a.stl': binarySTL(2), 'b.stl': binarySTL(3), 'c.stl': binarySTL(4), 'd.stl': binarySTL(5),
    [F10_PATH]: glbWithNodes(['retina']), [F10_SOLID]: glbWithNodes(['retina_solid']),
    progressTicks,
  });
  const parsers = createMeshParsers(createLoaders());
  const emitter = createEmitter();
  const events = [];
  for (const evt of ['layer:state', 'layer:progress', 'layer:error', 'layers:visible', 'sample:offset']) {
    emitter.on(evt, (payload) => events.push({ evt, ...payload }));
  }
  const layers = new LayerController({ pane, view, io, parsers, emitter });
  if (samples !== null) layers.setSamples(samples);
  const of = (evt) => events.filter((e) => e.evt === evt);
  return { pane, view, io, emitter, events, of, layers };
}

// Two samples, two STL layers each, plus an F10 coat on s1.
function twoSamples() {
  const a = structure('a', 's1'), b = structure('b', 's1');
  const f10 = structure('f10', 's1', { kind: 'gltf', path: F10_PATH, color: 0x00ff00 });
  const c = structure('c', 's2'), d = structure('d', 's2');
  return { a, b, c, d, f10, samples: [sample('s1', [a, b, f10]), sample('s2', [c, d], { offset: { x: 0.4, y: 0, z: 0 } })] };
}

const firstMesh = (obj) => { let m = null; obj.traverse((c) => { if (!m && c.isMesh) m = c; }); return m; };
const groupOf = (layers, sampleId) => layers.sampleGroups.get(sampleId);
// World-space centre of a group: a normalised group sits at offset × OVERLAY_TARGET.
const centerOf = (g) => new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3());

// Resolves once the controller has emitted `n` layer:progress events.
function afterProgress(ctx, n = 1) {
  return new Promise((resolve) => {
    const seen = () => ctx.of('layer:progress').length >= n;
    if (seen()) return resolve();
    const off = ctx.emitter.on('layer:progress', () => { if (seen()) { off(); resolve(); } });
  });
}

// ---------------------------------------------------------------------------
//  Pure helpers
// ---------------------------------------------------------------------------
describe('solidVariant / effectivePath', () => {
  test('maps an F10 coat path (remote or local optimized) to the shipped solid slab', () => {
    assert.equal(solidVariant(F10_PATH), F10_SOLID);
    assert.equal(solidVariant('optimized/F10_layers/choroid.glb?x=1'), 'optimized/F10_layers_solid/choroid.glb');
    assert.equal(solidVariant('optimized/f10_LAYERS/Sclera.GLB'), 'optimized/F10_layers_solid/Sclera.GLB');
  });

  test('is null for a non-F10 path, an STL, or no path at all', () => {
    assert.equal(solidVariant('a.stl'), null);
    assert.equal(solidVariant('other/F10_layers.glb'), null);
    assert.equal(solidVariant(null), null);
    assert.equal(solidVariant(undefined), null);
  });

  test('effectivePath honours view.solidFill only where a variant exists', () => {
    const f10 = structure('f10', 's1', { kind: 'gltf', path: F10_PATH });
    const stl = structure('a', 's1');
    assert.equal(effectivePath(f10, makeView()), F10_PATH);
    assert.equal(effectivePath(f10, makeView({ solidFill: true })), F10_SOLID);
    assert.equal(effectivePath(stl, makeView({ solidFill: true })), 'a.stl');
  });

  test('the instance method reads the live view', () => {
    const { layers, view } = makeCtx();
    const f10 = structure('f10', 's1', { kind: 'gltf', path: F10_PATH });
    assert.equal(layers.effectivePath(f10), F10_PATH);
    view.solidFill = true;
    assert.equal(layers.effectivePath(f10), F10_SOLID);
  });
});

describe('isHeavy', () => {
  test('null / missing bytes are not heavy; strictly above HEAVY_BYTES is', () => {
    const { layers } = makeCtx();
    assert.equal(HEAVY_BYTES, 400 * 1024 * 1024);
    assert.equal(layers.isHeavy(structure('a', 's1', { bytes: null })), false);
    assert.equal(layers.isHeavy(structure('a', 's1', { bytes: undefined })), false);
    assert.equal(layers.isHeavy(structure('a', 's1', { bytes: 0 })), false);
    assert.equal(layers.isHeavy(structure('a', 's1', { bytes: HEAVY_BYTES })), false);
    assert.equal(layers.isHeavy(structure('a', 's1', { bytes: HEAVY_BYTES + 1 })), true);
  });
});

// ---------------------------------------------------------------------------
//  Construction and the empty default
// ---------------------------------------------------------------------------
describe('construction / default samples', () => {
  test('owns empty maps, stlFitted false and samples = [] before any manifest', () => {
    const { layers, pane, view, emitter } = makeCtx();
    assert.equal(layers.pane, pane);
    assert.equal(layers.view, view);
    assert.equal(layers.emitter, emitter);
    assert.deepEqual(layers.samples, []);
    assert.equal(layers.sampleGroups.size, 0);
    assert.equal(layers.featureObjects.size, 0);
    assert.equal(layers.inFlight.size, 0);
    assert.equal(layers.stlFitted, false);
    assert.equal(layers.groupCount(), 0);
    assert.equal(layers.has('a'), false);
    assert.equal(layers.anyVisible(), false);
    assert.deepEqual(layers.visibleIds(), []);
  });

  test('findStructure / findSample return null on the empty default', () => {
    const { layers } = makeCtx();
    assert.equal(layers.findStructure('x'), null);
    assert.equal(layers.findSample('x'), null);
  });

  test('snapOffsetsToFirst and resetOffsets(sample) while linked do not throw with no samples', () => {
    const { layers, view, events } = makeCtx({ view: { linkOffsets: true } });
    assert.doesNotThrow(() => layers.snapOffsetsToFirst());
    const lone = sample('ghost', []);
    assert.doesNotThrow(() => layers.resetOffsets(lone));
    assert.equal(view.linkOffsets, true);
    assert.equal(events.length, 0, 'nothing to move, nothing emitted');
  });

  test('setSamples stores the array reference (later mutations are seen)', () => {
    const { layers } = makeCtx();
    const arr = [sample('s1', [structure('a', 's1')])];
    layers.setSamples(arr);
    assert.equal(layers.samples, arr);
    arr.push(sample('s2', [structure('c', 's2')]));
    assert.equal(layers.findSample('s2').id, 's2');
    assert.equal(layers.findStructure('c').sampleId, 's2');
    assert.equal(layers.findStructure('zzz'), null);
  });

  test('getSampleGroup creates one tagged group per sample under pane.root and reuses it', () => {
    const { layers, pane } = makeCtx();
    const g = layers.getSampleGroup('s1');
    assert.equal(g.parent, pane.root);
    assert.equal(g.userData.sampleId, 's1');
    assert.equal(layers.getSampleGroup('s1'), g);
    assert.equal(layers.groupCount(), 1);
    layers.getSampleGroup('s2');
    assert.equal(layers.groupCount(), 2);
    assert.equal(pane.root.children.length, 2);
  });
});

// ---------------------------------------------------------------------------
//  load()
// ---------------------------------------------------------------------------
describe('load()', () => {
  test('emits loading/start → progress 50 → progress 100 → loading/build → layers:visible → loaded {cached:false}', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a);
    const seq = ctx.events.map((e) => e.evt === 'layer:progress' ? `progress ${e.pct}` : e.evt === 'layer:state' ? `state ${e.state}${e.phase ? '/' + e.phase : ''}` : e.evt);
    assert.deepEqual(seq, ['state loading/start', 'progress 50', 'progress 100', 'state loading/build', 'layers:visible', 'state loaded']);
    const loaded = ctx.of('layer:state').at(-1);
    assert.deepEqual(loaded, { evt: 'layer:state', id: 'a', state: 'loaded', cached: false });
    const p = ctx.of('layer:progress')[0];
    assert.equal(p.id, 'a');
    assert.equal(p.total, binarySTL(2).byteLength);
    assert.equal(p.loaded, Math.round(p.total / 2));
    assert.deepEqual(ctx.of('layers:visible')[0], { evt: 'layers:visible', anyVisible: true, visibleIds: ['a'] });
    assert.equal(ctx.of('layer:error').length, 0);
  });

  test('a cached URL reports loading/cache instead of progress and ends loaded {cached:true}', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples, routes: { 'a.stl': binarySTL(1), cached: ['a.stl'] } });
    await ctx.layers.load(a);
    assert.equal(ctx.of('layer:progress').length, 0);
    const states = ctx.of('layer:state').map((e) => `${e.state}${e.phase ? '/' + e.phase : ''}`);
    assert.deepEqual(states, ['loading/start', 'loading/cache', 'loading/build', 'loaded']);
    assert.equal(ctx.of('layer:state').at(-1).cached, true);
  });

  test('places the object under its sample group, tagged, coloured and normalised; bounds and stlFitted set', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    const { layers, pane } = ctx;
    await layers.load(a);

    assert.equal(layers.has('a'), true);
    const obj = layers.featureObjects.get('a');
    assert.equal(obj.userData.id, 'a');
    const g = groupOf(layers, 's1');
    assert.equal(obj.parent, g);
    assert.equal(g.parent, pane.root);
    assert.equal(layers.groupCount(), 1);
    assert.equal(firstMesh(obj).material.color.getHex(), 0xff0000);

    // binarySTL(2) spans 1×1×1 → normalised to OVERLAY_TARGET and centred at the origin
    near(g.scale.x, OVERLAY_TARGET);
    const box = new THREE.Box3().setFromObject(g);
    const c = box.getCenter(new THREE.Vector3());
    near(c.x, 0); near(c.y, 0); near(c.z, 0);
    near(box.getSize(new THREE.Vector3()).x, OVERLAY_TARGET);

    assert.equal(pane.bounds.isEmpty(), false);
    assert.equal(layers.stlFitted, true);
    assert.equal(layers.inFlight.size, 0);
    assert.equal(ctx.io.calls[0].url, 'a.stl');
  });

  test('opacity = layer × sample × global', async () => {
    const { a, samples } = twoSamples();
    a.opacity = 0.5;
    samples[0].opacity = 0.8;
    const ctx = makeCtx({ samples, view: { globalOpacity: 0.5 } });
    await ctx.layers.load(a);
    const m = firstMesh(ctx.layers.featureObjects.get('a')).material;
    near(m.opacity, 0.2);
    assert.equal(m.transparent, true);
    assert.equal(m.depthWrite, false);
  });

  test('a GLB layer goes through parseGLTF (white re-skin, then recoloured)', async () => {
    const { f10, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(f10);
    const obj = ctx.layers.featureObjects.get('f10');
    assert.ok(obj.getObjectByName('retina'), 'GLB node names survive');
    assert.equal(firstMesh(obj).material.color.getHex(), 0x00ff00);
  });

  test('fits the workspace on the first load and again for a new sample group, not for a second layer in the same group', async () => {
    const { a, b, c, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    const { layers } = ctx;
    const fits = [];
    const orig = layers.fitStl.bind(layers);
    layers.fitStl = (offset) => { fits.push(offset); return orig(offset); };

    await layers.load(a);
    assert.deepEqual(fits, [1.45]);
    await layers.load(b);
    assert.deepEqual(fits, [1.45], 'same group: no refit');
    await layers.load(c);
    assert.deepEqual(fits, [1.45, 1.45], 'new group: refit');
    assert.equal(layers.groupCount(), 2);
  });

  test('fits at 1.7 in overlay layout', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples, view: { layout: 'overlay' } });
    const fits = [];
    const orig = ctx.layers.fitStl.bind(ctx.layers);
    ctx.layers.fitStl = (offset) => { fits.push(offset); return orig(offset); };
    await ctx.layers.load(a);
    assert.deepEqual(fits, [1.7]);
  });

  test('fitStl frames the union of the sample groups at the given offset and refreshes the bounds', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    const { layers, pane } = ctx;
    await layers.load(a);
    layers.fitStl(1.45);
    const expected = fitDistance(pane.camera, OVERLAY_TARGET, 1.45);
    near(pane.defaultDist, expected);
    near(pane.controls.getDistance(), expected);
    // an empty workspace is a no-op
    const empty = makeCtx();
    const before = empty.pane.camera.position.clone();
    empty.layers.fitStl();
    assert.deepEqual(empty.pane.camera.position.toArray(), before.toArray());
  });

  test('abort(id) mid-download → exactly one layer:state idle, no error, inFlight cleared, promise resolves', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples, progressTicks: 4 });
    const { layers } = ctx;
    const p = layers.load(a);
    assert.equal(layers.inFlight.has('a'), true);
    await afterProgress(ctx, 1);
    layers.abort('a');
    await p;   // never rejects
    const states = ctx.of('layer:state').map((e) => e.state);
    assert.deepEqual(states, ['loading', 'idle']);
    assert.equal(ctx.of('layer:state').filter((e) => e.state === 'idle').length, 1);
    assert.equal(ctx.of('layer:error').length, 0);
    assert.equal(layers.inFlight.size, 0);
    assert.equal(layers.has('a'), false);
    assert.equal(layers.groupCount(), 0, 'no group is created for an aborted layer');
  });

  test('abort() on an unknown id is a no-op and emits nothing', () => {
    const { layers, events } = makeCtx();
    assert.doesNotThrow(() => layers.abort('nope'));
    assert.equal(events.length, 0);
  });

  test('abortAll() aborts every in-flight download, each ending in one idle', async () => {
    const { a, c, samples } = twoSamples();
    const ctx = makeCtx({ samples, progressTicks: 4 });
    const p1 = ctx.layers.load(a), p2 = ctx.layers.load(c);
    await afterProgress(ctx, 2);
    ctx.layers.abortAll();
    await Promise.all([p1, p2]);
    const idle = ctx.of('layer:state').filter((e) => e.state === 'idle').map((e) => e.id).sort();
    assert.deepEqual(idle, ['a', 'c']);
    assert.equal(ctx.layers.inFlight.size, 0);
  });

  test('a non-abort failure emits layer:state error then layer:error, resolves, and leaves no object', async () => {
    const { samples } = twoSamples();
    const bad = structure('missing', 's1', { path: 'missing.stl', label: 'Missing' });
    samples[0].structures.push(bad);
    const ctx = makeCtx({ samples });
    const err = mock.method(console, 'error', () => {});
    try {
      await ctx.layers.load(bad);
    } finally { err.mock.restore(); }
    assert.equal(err.mock.callCount(), 1, 'the failure is logged (parity)');
    const tail = ctx.events.slice(-2);
    assert.deepEqual(tail[0], { evt: 'layer:state', id: 'missing', state: 'error' });
    assert.equal(tail[1].evt, 'layer:error');
    assert.equal(tail[1].id, 'missing');
    assert.equal(tail[1].label, 'Missing');
    assert.match(tail[1].error.message, /404/);
    assert.equal(ctx.of('layers:visible').length, 0);
    assert.equal(ctx.layers.has('missing'), false);
    assert.equal(ctx.layers.inFlight.size, 0);
  });

  test('a pre-aborted signal (abort before the first tick) still yields one idle', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    const p = ctx.layers.load(a);
    ctx.layers.abort('a');
    await p;
    assert.deepEqual(ctx.of('layer:state').map((e) => e.state), ['loading', 'idle']);
  });
});

// ---------------------------------------------------------------------------
//  Visibility
// ---------------------------------------------------------------------------
describe('visibility', () => {
  test('setVisible(id, false) hides without disposing and emits layers:visible {anyVisible:false}', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a);
    const obj = ctx.layers.featureObjects.get('a');
    const dispose = mock.method(firstMesh(obj).geometry, 'dispose');
    ctx.events.length = 0;

    ctx.layers.setVisible('a', false);
    assert.equal(obj.visible, false);
    assert.equal(obj.parent, groupOf(ctx.layers, 's1'), 'still in the scene graph');
    assert.equal(ctx.layers.has('a'), true);
    assert.equal(dispose.mock.callCount(), 0);
    assert.deepEqual(ctx.events, [{ evt: 'layers:visible', anyVisible: false, visibleIds: [] }]);

    ctx.layers.setVisible('a', true);
    assert.equal(obj.visible, true);
    assert.deepEqual(ctx.events.at(-1), { evt: 'layers:visible', anyVisible: true, visibleIds: ['a'] });
  });

  test("setVisible('never-loaded', false) still emits layers:visible (parity with the unconditional refreshStlEmpty)", async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    ctx.layers.setVisible('never-loaded', false);
    assert.deepEqual(ctx.events, [{ evt: 'layers:visible', anyVisible: false, visibleIds: [] }]);

    await ctx.layers.load(a);
    ctx.events.length = 0;
    ctx.layers.setVisible('never-loaded', false);
    assert.deepEqual(ctx.events, [{ evt: 'layers:visible', anyVisible: true, visibleIds: ['a'] }], 'reports the real state, untouched');
  });

  test('visibleIds lists loaded objects that are visible, in insertion order', async () => {
    const { a, b, c, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a); await ctx.layers.load(b); await ctx.layers.load(c);
    assert.deepEqual(ctx.layers.visibleIds(), ['a', 'b', 'c']);
    ctx.layers.setVisible('b', false);
    assert.deepEqual(ctx.layers.visibleIds(), ['a', 'c']);
    assert.equal(ctx.layers.anyVisible(), true);
    ctx.layers.setVisible('a', false); ctx.layers.setVisible('c', false);
    assert.equal(ctx.layers.anyVisible(), false);
  });

  test('setSampleVisible flips only group.visible and emits nothing', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a);
    ctx.events.length = 0;
    ctx.layers.setSampleVisible('s1', false);
    assert.equal(groupOf(ctx.layers, 's1').visible, false);
    assert.equal(ctx.layers.featureObjects.get('a').visible, true, 'the layer object itself is untouched');
    assert.equal(ctx.events.length, 0);
    ctx.layers.setSampleVisible('s1', true);
    assert.equal(groupOf(ctx.layers, 's1').visible, true);
    assert.doesNotThrow(() => ctx.layers.setSampleVisible('unknown', false));
    assert.equal(ctx.events.length, 0);
  });

  test('syncVisibility rebuilds caps before it reports', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a);
    // Something stale in the cap group must be gone by the time the event lands.
    ctx.pane.capGroup.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()));
    let capsAtEmit = -1;
    ctx.emitter.on('layers:visible', () => { capsAtEmit = ctx.pane.capGroup.children.length; });
    ctx.layers.syncVisibility();
    assert.equal(capsAtEmit, 0);
  });
});

// ---------------------------------------------------------------------------
//  Colour and opacity
// ---------------------------------------------------------------------------
describe('colour / opacity', () => {
  test('setColor records the hex on the structure and recolours the loaded object', async () => {
    const { a, b, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a);
    ctx.layers.setColor(a, 0x123456);
    assert.equal(a.color, 0x123456);
    assert.equal(firstMesh(ctx.layers.featureObjects.get('a')).material.color.getHex(), 0x123456);
    // not loaded yet: the record changes, nothing else
    ctx.layers.setColor(b, 0xabcdef);
    assert.equal(b.color, 0xabcdef);
    assert.equal(ctx.layers.has('b'), false);
    assert.equal(ctx.events.filter((e) => e.evt !== 'layer:state' && e.evt !== 'layer:progress').length, 1, 'only the load reported visibility');
  });

  test('setOpacity / setSampleOpacity / reapplyAllOpacity multiply through to the materials', async () => {
    const { a, b, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a); await ctx.layers.load(b);
    const mA = firstMesh(ctx.layers.featureObjects.get('a')).material;
    const mB = firstMesh(ctx.layers.featureObjects.get('b')).material;

    ctx.layers.setOpacity(a, 0.5);
    assert.equal(a.opacity, 0.5);
    near(mA.opacity, 0.5); near(mB.opacity, 1);

    ctx.layers.setSampleOpacity(samples[0], 0.5);
    assert.equal(samples[0].opacity, 0.5);
    near(mA.opacity, 0.25); near(mB.opacity, 0.5);

    ctx.view.globalOpacity = 0.5;
    ctx.layers.reapplyAllOpacity();
    near(mA.opacity, 0.125); near(mB.opacity, 0.25);
    assert.equal(mB.transparent, true);
    assert.equal(mB.renderOrder, undefined, 'renderOrder lives on the mesh, not the material');
    assert.equal(firstMesh(ctx.layers.featureObjects.get('b')).renderOrder, 1);
  });

  test('reapplyOpacity on an unloaded structure is a no-op', () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    assert.doesNotThrow(() => ctx.layers.reapplyOpacity(a));
    assert.doesNotThrow(() => ctx.layers.reapplyAllOpacity());
    assert.equal(ctx.events.length, 0);
  });
});

// ---------------------------------------------------------------------------
//  Offsets
// ---------------------------------------------------------------------------
describe('offsets', () => {
  test('setSampleOffset writes the record, emits sample:offset and re-normalises the group', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a);
    const g = groupOf(ctx.layers, 's1');
    const before = g.position.x;
    ctx.events.length = 0;

    ctx.layers.setSampleOffset(samples[0], 'x', 0.4);
    assert.equal(samples[0].offset.x, 0.4);
    assert.deepEqual(ctx.events, [{ evt: 'sample:offset', sampleId: 's1', axis: 'x', value: 0.4 }]);
    near(g.position.x - before, 0.4 * OVERLAY_TARGET);
  });

  test('setSampleOffset on a sample without a group still emits and records', () => {
    const { samples } = twoSamples();
    const ctx = makeCtx({ samples });
    ctx.layers.setSampleOffset(samples[1], 'z', -0.25);
    assert.equal(samples[1].offset.z, -0.25);
    assert.deepEqual(ctx.events, [{ evt: 'sample:offset', sampleId: 's2', axis: 'z', value: -0.25 }]);
  });

  test('offsetChanged moves only the edited sample when unlinked, every sample when linked', async () => {
    const { a, c, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a); await ctx.layers.load(c);
    ctx.events.length = 0;

    ctx.layers.offsetChanged(samples[0], 'y', 0.3);
    assert.equal(samples[0].offset.y, 0.3);
    assert.equal(samples[1].offset.y, 0);
    assert.deepEqual(ctx.of('sample:offset').map((e) => e.sampleId), ['s1']);

    ctx.view.linkOffsets = true;
    ctx.events.length = 0;
    ctx.layers.offsetChanged(samples[1], 'y', -0.2);
    assert.equal(samples[0].offset.y, -0.2);
    assert.equal(samples[1].offset.y, -0.2);
    assert.deepEqual(ctx.of('sample:offset').map((e) => [e.sampleId, e.axis, e.value]), [['s1', 'y', -0.2], ['s2', 'y', -0.2]]);
    near(centerOf(groupOf(ctx.layers, 's1')).y, -0.2 * OVERLAY_TARGET);
    near(centerOf(groupOf(ctx.layers, 's2')).y, -0.2 * OVERLAY_TARGET);
  });

  test('resetOffsets zeroes the edited sample, or every sample when linked', async () => {
    const { a, c, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a); await ctx.layers.load(c);
    samples[0].offset = { x: 0.1, y: 0.2, z: 0.3 };
    ctx.events.length = 0;

    ctx.layers.resetOffsets(samples[0]);
    assert.deepEqual(samples[0].offset, { x: 0, y: 0, z: 0 });
    assert.deepEqual(samples[1].offset, { x: 0.4, y: 0, z: 0 }, 'the other sample keeps its offset');
    assert.equal(ctx.of('sample:offset').length, 3);

    ctx.view.linkOffsets = true;
    ctx.events.length = 0;
    ctx.layers.resetOffsets(samples[0]);
    assert.deepEqual(samples[1].offset, { x: 0, y: 0, z: 0 });
    assert.equal(ctx.of('sample:offset').length, 6);
    near(centerOf(groupOf(ctx.layers, 's2')).x, 0);
    near(centerOf(groupOf(ctx.layers, 's1')).x, 0);
  });

  test('snapOffsetsToFirst snaps every sample to samples[0].offset, one event per sample per axis', async () => {
    const { a, c, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a); await ctx.layers.load(c);
    samples[0].offset = { x: 0.1, y: -0.1, z: 0.5 };
    ctx.events.length = 0;

    ctx.layers.snapOffsetsToFirst();
    assert.deepEqual(samples[1].offset, { x: 0.1, y: -0.1, z: 0.5 });
    assert.deepEqual(samples[0].offset, { x: 0.1, y: -0.1, z: 0.5 });
    const ev = ctx.of('sample:offset');
    assert.equal(ev.length, 6);
    assert.deepEqual(ev.map((e) => `${e.sampleId}.${e.axis}=${e.value}`), ['s1.x=0.1', 's2.x=0.1', 's1.y=-0.1', 's2.y=-0.1', 's1.z=0.5', 's2.z=0.5']);
    const g1 = groupOf(ctx.layers, 's1'), g2 = groupOf(ctx.layers, 's2');
    for (const g of [g1, g2]) {
      const c = centerOf(g);
      near(c.x, 0.1 * OVERLAY_TARGET); near(c.y, -0.1 * OVERLAY_TARGET); near(c.z, 0.5 * OVERLAY_TARGET);
    }
  });
});

// ---------------------------------------------------------------------------
//  Framing helpers
// ---------------------------------------------------------------------------
describe('framing', () => {
  test('workspaceBox unions the visible, non-empty sample groups and ignores hidden / empty ones', async () => {
    const { a, c, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a); await ctx.layers.load(c);
    ctx.layers.getSampleGroup('empty');   // an empty group must not shrink the box to a point

    const both = ctx.layers.workspaceBox();
    const s1Only = new THREE.Box3().setFromObject(groupOf(ctx.layers, 's1'));
    assert.ok(both.max.x > s1Only.max.x + 1, 's2 sits 0.4×target to the right of s1');

    ctx.layers.setSampleVisible('s2', false);
    const hidden = ctx.layers.workspaceBox();
    near(hidden.max.x, s1Only.max.x);
    near(hidden.min.x, s1Only.min.x);
  });

  test('focusSample fits the sample group at 1.6 and refreshes bounds; unknown / empty samples are no-ops', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    const { layers, pane } = ctx;
    await layers.load(a);
    pane.camera.position.set(0, 0, 5); pane.controls.update();

    layers.focusSample('s1');
    const box = new THREE.Box3().setFromObject(groupOf(layers, 's1'));
    const size = box.getSize(new THREE.Vector3());
    const expected = fitDistance(pane.camera, Math.max(size.x, size.y, size.z), 1.6);
    near(pane.defaultDist, expected);
    near(pane.controls.getDistance(), expected);

    const pos = pane.camera.position.clone();
    layers.focusSample('nope');
    layers.getSampleGroup('empty');
    layers.focusSample('empty');
    assert.deepEqual(pane.camera.position.toArray(), pos.toArray());
  });
});

// ---------------------------------------------------------------------------
//  Solid-fill reload
// ---------------------------------------------------------------------------
describe('reloadFillVariants', () => {
  test('re-fetches the solid variant of every loaded F10 coat, disposing the old object and preserving visible=false', async () => {
    const { a, f10, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    const { layers, io, pane } = ctx;
    await layers.load(a); await layers.load(f10);
    const oldObj = layers.featureObjects.get('f10');
    const oldGeomDispose = mock.method(firstMesh(oldObj).geometry, 'dispose');
    layers.setVisible('f10', false);
    ctx.events.length = 0;
    io.calls.length = 0;

    // Caps must be cleared BEFORE the first re-fetch (they reference the geometry being disposed).
    pane.capGroup.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()));
    let capsAtFetch = -1;
    const origFetch = io.fetchBuffer;
    io.fetchBuffer = (url, opts) => { if (capsAtFetch < 0) capsAtFetch = pane.capGroup.children.length; return origFetch(url, opts); };

    ctx.view.solidFill = true;
    await layers.reloadFillVariants();

    assert.deepEqual(io.calls.map((c) => c.url), [F10_SOLID], 'only the F10 coat is re-fetched, from the solid path');
    assert.equal(capsAtFetch, 0);
    assert.equal(oldGeomDispose.mock.callCount(), 1);
    assert.equal(oldObj.parent, null, 'the old object left the scene graph');
    const fresh = layers.featureObjects.get('f10');
    assert.notEqual(fresh, oldObj);
    assert.ok(fresh.getObjectByName('retina_solid'));
    assert.equal(fresh.parent, groupOf(layers, 's1'));
    assert.equal(fresh.visible, false, 'the row was unchecked; it stays hidden');
    assert.equal(layers.featureObjects.get('a').visible, true, 'the STL layer is untouched');

    // N+1 layers:visible: one from the reload's load(), one final; the final one reflects the real state.
    const vis = ctx.of('layers:visible');
    assert.equal(vis.length, 2);
    assert.deepEqual(vis[0], { evt: 'layers:visible', anyVisible: true, visibleIds: ['a', 'f10'] }, 'mid-reload the fresh object is visible until wasVisible is restored');
    assert.deepEqual(vis.at(-1), { evt: 'layers:visible', anyVisible: true, visibleIds: ['a'] });
  });

  test('a visible coat comes back visible; toggling solidFill off reloads the original path', async () => {
    const { f10, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(f10);
    ctx.view.solidFill = true;
    await ctx.layers.reloadFillVariants();
    assert.equal(ctx.layers.featureObjects.get('f10').visible, true);
    ctx.io.calls.length = 0;
    ctx.view.solidFill = false;
    await ctx.layers.reloadFillVariants();
    assert.deepEqual(ctx.io.calls.map((c) => c.url), [F10_PATH]);
    assert.ok(ctx.layers.featureObjects.get('f10').getObjectByName('retina'));
  });

  test('with nothing affected it only clears caps and emits one layers:visible', async () => {
    const { a, samples } = twoSamples();
    const ctx = makeCtx({ samples });
    await ctx.layers.load(a);
    ctx.events.length = 0; ctx.io.calls.length = 0;
    ctx.view.solidFill = true;
    await ctx.layers.reloadFillVariants();
    assert.equal(ctx.io.calls.length, 0);
    assert.deepEqual(ctx.events, [{ evt: 'layers:visible', anyVisible: true, visibleIds: ['a'] }]);
  });

  test('aborts an in-flight re-download of an affected coat (one idle from the aborted load)', async () => {
    const { f10, samples } = twoSamples();
    const ctx = makeCtx({ samples, progressTicks: 4 });
    await ctx.layers.load(f10);
    ctx.events.length = 0;
    const dup = ctx.layers.load(f10);          // a second download of the same coat, still running
    await afterProgress(ctx, 1);
    ctx.view.solidFill = true;
    await Promise.all([ctx.layers.reloadFillVariants(), dup]);
    const idle = ctx.of('layer:state').filter((e) => e.state === 'idle');
    assert.equal(idle.length, 1);
    assert.equal(ctx.of('layer:error').length, 0);
    assert.ok(ctx.layers.featureObjects.get('f10').getObjectByName('retina_solid'), 'the solid variant won');
  });
});
