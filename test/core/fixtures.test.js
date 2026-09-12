// ============================================================================
//  Tests for test/helpers/fixtures.js — the synthetic meshes must be accepted
//  by the real three.js loaders (names intact), and the io stub must honour
//  the fetchBuffer contract (progress ticks, cache hits, abort, 404).
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { binarySTL, glbWithNodes, namedBoxGroup, stubIo } from '../helpers/fixtures.js';

const parseGLB = (buffer) => new Promise((resolve, reject) => {
  new GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene), reject);
});

describe('binarySTL', () => {
  test('has the binary layout STLLoader expects and parses to n triangles', () => {
    for (const n of [1, 3]) {
      const buf = binarySTL(n);
      assert.equal(buf.byteLength, 84 + n * 50);
      const geometry = new STLLoader().parse(buf);
      assert.equal(geometry.attributes.position.count, n * 3);
      geometry.computeBoundingBox();
      assert.equal(geometry.boundingBox.max.z, n - 1);   // triangle i sits at z = i
    }
  });
});

describe('glbWithNodes', () => {
  test('parses under GLTFLoader with one named mesh per node', async () => {
    const names = ['sclera', 'choroid', 'retina'];
    const scene = await parseGLB(glbWithNodes(names));
    const meshes = [];
    scene.traverse((c) => { if (c.isMesh) meshes.push(c); });
    assert.deepEqual(meshes.map((m) => m.name).sort(), names.slice().sort());
    for (const m of meshes) {
      assert.equal(m.geometry.attributes.position.count, 3);
      assert.equal(m.geometry.attributes.normal, undefined);   // default: no normals
      assert.ok(m.material, 'each node keeps its own material');
    }
  });

  test('normals option writes a NORMAL accessor', async () => {
    const scene = await parseGLB(glbWithNodes(['a'], { normals: true }));
    const mesh = scene.getObjectByName('a');
    assert.ok(mesh?.isMesh);
    assert.equal(mesh.geometry.attributes.normal.count, 3);
    assert.deepEqual(Array.from(mesh.geometry.attributes.normal.array.slice(0, 3)), [0, 0, 1]);
  });

  test('assetVersion 1.0 is structurally valid but reported through onError, not thrown', async () => {
    const buf = glbWithNodes(['a'], { assetVersion: '1.0' });
    assert.equal(new DataView(buf).getUint32(0, true), 0x46546C67, 'still a GLB');
    let threw = null, reported = null;
    try {
      new GLTFLoader().parse(buf, '', () => {}, (e) => { reported = e; });
    } catch (e) { threw = e; }
    assert.equal(threw, null, 'the loader returns rather than throwing');
    assert.match(reported.message, /versions >=2\.0/);
  });

  test('chunks are 4-byte aligned and the header length matches', () => {
    const buf = glbWithNodes(['x', 'yy']);
    const dv = new DataView(buf);
    assert.equal(dv.getUint32(0, true), 0x46546C67);
    assert.equal(dv.getUint32(8, true), buf.byteLength);
    assert.equal(buf.byteLength % 4, 0);
    assert.equal(dv.getUint32(12, true) % 4, 0);           // JSON chunk length
  });
});

describe('namedBoxGroup', () => {
  test('builds one unit box per name spread along x', () => {
    const g = namedBoxGroup(['a', 'b', 'c']);
    assert.equal(g.children.length, 3);
    assert.deepEqual(g.children.map((c) => c.name), ['a', 'b', 'c']);
    const box = new THREE.Box3().setFromObject(g);
    assert.equal(box.min.x, -0.5);
    assert.equal(box.max.x, 2.5);
    assert.equal(box.max.y - box.min.y, 1);
  });
});

describe('stubIo', () => {
  test('streams progress ticks then resolves a copy of the bytes', async () => {
    const io = stubIo({ 'a.stl': binarySTL(2), progressTicks: 4 });
    const ticks = [];
    const buf = await io.fetchBuffer('a.stl', { onProgress: (p) => ticks.push(p) });
    const total = 84 + 2 * 50;
    assert.deepEqual(ticks, [
      { loaded: Math.round(total / 4), total }, { loaded: Math.round(total / 2), total },
      { loaded: Math.round((3 * total) / 4), total }, { loaded: total, total },
    ]);
    assert.equal(buf.byteLength, total);
    assert.deepEqual(io.calls, [{ url: 'a.stl', fromCache: false }]);
    assert.equal(await io.isCached('a.stl'), false);
    // Each call hands out its own buffer, so a consumer cannot corrupt the fixture.
    const again = await io.fetchBuffer('a.stl');
    assert.notEqual(again, buf);
  });

  test('a cached URL reports one fromCache tick and isCached true', async () => {
    const io = stubIo({ 'c.glb': new Uint8Array([1, 2, 3]), cached: ['c.glb'] });
    const ticks = [];
    const buf = await io.fetchBuffer('c.glb', { onProgress: (p) => ticks.push(p) });
    assert.deepEqual(ticks, [{ loaded: 3, total: 3, fromCache: true }]);
    assert.deepEqual(Array.from(new Uint8Array(buf)), [1, 2, 3]);
    assert.equal(await io.isCached('c.glb'), true);
    assert.equal(await io.isCached('other'), false);
  });

  test('hideTotal reports every tick with total 0 (a response with no Content-Length)', async () => {
    const io = stubIo({ 'a.stl': binarySTL(1), progressTicks: 2, hideTotal: true });
    const ticks = [];
    await io.fetchBuffer('a.stl', { onProgress: (p) => ticks.push(p) });
    assert.deepEqual(ticks.map((t) => t.total), [0, 0]);
    assert.ok(ticks.every((t) => t.loaded > 0), 'the byte counter still runs');
  });

  test('an already-aborted signal rejects with AbortError before any tick', async () => {
    const io = stubIo({ 'a.stl': binarySTL(1) });
    const ac = new AbortController();
    ac.abort();
    let ticks = 0;
    await assert.rejects(
      io.fetchBuffer('a.stl', { signal: ac.signal, onProgress: () => ticks++ }),
      (e) => e.name === 'AbortError',
    );
    assert.equal(ticks, 0);
  });

  test('aborting mid-download rejects with AbortError and stops progress', async () => {
    const io = stubIo({ 'a.stl': binarySTL(1), progressTicks: 3 });
    const ac = new AbortController();
    const ticks = [];
    const p = io.fetchBuffer('a.stl', {
      signal: ac.signal,
      onProgress: (t) => { ticks.push(t); if (ticks.length === 1) ac.abort(); },
    });
    await assert.rejects(p, (e) => e.name === 'AbortError');
    assert.equal(ticks.length, 1);
  });

  test('an unknown URL rejects like a 404 and is not an AbortError', async () => {
    const io = stubIo({});
    await assert.rejects(io.fetchBuffer('missing.glb'), (e) => /404/.test(e.message) && e.name !== 'AbortError');
  });
});
