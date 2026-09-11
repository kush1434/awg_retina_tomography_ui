// ============================================================================
//  Tests for core/mesh-parsers.js — createLoaders wiring the Draco decoder
//  path into a GLTFLoader, parseSTL building one mesh in the structure's
//  colour / opacity with computed normals, parseGLTF re-skinning every mesh
//  white with normals and culling off, and parseAnatomyGLTF keeping the
//  file's own materials and node names. Runs on the in-memory fixtures; Draco
//  decoding itself is browser-only and covered by the e2e suite.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { createLoaders, createMeshParsers } from '../../core/mesh-parsers.js';
import { binarySTL, glbWithNodes } from '../helpers/fixtures.js';

const DEFAULT_DRACO = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

const meshesOf = (scene) => { const out = []; scene.traverse((c) => { if (c.isMesh) out.push(c); }); return out; };

describe('createLoaders', () => {
  test('builds the STL / GLTF / DRACO trio with the GLTF loader wired to Draco', () => {
    const { dracoLoader, gltfLoader, stlLoader } = createLoaders();
    assert.ok(dracoLoader instanceof DRACOLoader);
    assert.ok(gltfLoader instanceof GLTFLoader);
    assert.ok(stlLoader instanceof STLLoader);
    assert.equal(gltfLoader.dracoLoader, dracoLoader);
  });

  test('points Draco at the gstatic 1.5.7 decoders by default', () => {
    assert.equal(createLoaders().dracoLoader.decoderPath, DEFAULT_DRACO);
  });

  test('honours a custom dracoDecoderPath', () => {
    const { dracoLoader } = createLoaders({ dracoDecoderPath: './vendor/draco/' });
    assert.equal(dracoLoader.decoderPath, './vendor/draco/');
  });

  test('every call returns fresh loader instances', () => {
    const a = createLoaders();
    const b = createLoaders();
    assert.notEqual(a.gltfLoader, b.gltfLoader);
    assert.notEqual(a.stlLoader, b.stlLoader);
    assert.notEqual(a.dracoLoader, b.dracoLoader);
  });
});

describe('parseSTL', () => {
  const { parseSTL } = createMeshParsers(createLoaders());

  test('one triangle becomes a Mesh with 3 positions and computed normals', () => {
    const mesh = parseSTL(binarySTL(1), { color: 0xff8800, opacity: 0.6 });
    assert.ok(mesh instanceof THREE.Mesh);
    assert.equal(mesh.geometry.attributes.position.count, 3);
    assert.ok(mesh.geometry.attributes.normal, 'normals computed');
    assert.equal(mesh.geometry.attributes.normal.count, 3);
    // The fixture triangle lies in the XY plane so its normal is ±z.
    const n = mesh.geometry.attributes.normal;
    assert.ok(Math.abs(Math.abs(n.getZ(0)) - 1) < 1e-6);
  });

  test('n triangles give 3n positions', () => {
    const mesh = parseSTL(binarySTL(4), { color: 0xffffff, opacity: 1 });
    assert.equal(mesh.geometry.attributes.position.count, 12);
  });

  test('a translucent structure gets a transparent, DoubleSide material in its colour', () => {
    const mesh = parseSTL(binarySTL(1), { color: 0x2266cc, opacity: 0.35 });
    const m = mesh.material;
    assert.ok(m instanceof THREE.MeshStandardMaterial);
    assert.equal(m.color.getHex(), 0x2266cc);
    assert.equal(m.opacity, 0.35);
    assert.equal(m.transparent, true);
    assert.equal(m.depthWrite, false);
    assert.equal(m.side, THREE.DoubleSide);
  });

  test('an opaque structure is not transparent and writes depth', () => {
    const m = parseSTL(binarySTL(1), { color: 0x00ff00, opacity: 1 }).material;
    assert.equal(m.transparent, false);
    assert.equal(m.depthWrite, true);
    assert.equal(m.color.getHex(), 0x00ff00);
  });
});

describe('parseGLTF', () => {
  const { parseGLTF } = createMeshParsers(createLoaders());

  test('resolves the scene with culling off, a white opaque material and computed normals', async () => {
    const scene = await parseGLTF(glbWithNodes(['a']));
    assert.ok(scene instanceof THREE.Object3D);
    const meshes = meshesOf(scene);
    assert.equal(meshes.length, 1);
    const [mesh] = meshes;
    assert.equal(mesh.frustumCulled, false);
    assert.ok(mesh.geometry.attributes.normal, 'normals computed when the file has none');
    assert.ok(mesh.material instanceof THREE.MeshStandardMaterial);
    assert.equal(mesh.material.color.getHex(), 0xffffff);
    assert.equal(mesh.material.opacity, 1);
    assert.equal(mesh.material.transparent, false);
    assert.equal(mesh.material.side, THREE.DoubleSide);
  });

  test('replaces the file material on every mesh, not just the first', async () => {
    const scene = await parseGLTF(glbWithNodes(['a', 'b', 'c']));
    const meshes = meshesOf(scene);
    assert.equal(meshes.length, 3);
    for (const m of meshes) {
      assert.equal(m.frustumCulled, false);
      assert.equal(m.material.color.getHex(), 0xffffff);
      assert.notEqual(m.material.name, `${m.name}_mat`, 'file material was swapped out');
    }
  });

  test('keeps normals the file already carries', async () => {
    const scene = await parseGLTF(glbWithNodes(['a'], { normals: true }));
    const [mesh] = meshesOf(scene);
    const n = mesh.geometry.attributes.normal;
    assert.equal(n.count, 3);
    assert.equal(n.getZ(0), 1);
  });

  test('rejects on a buffer that is not a GLB', async () => {
    await assert.rejects(parseGLTF(new ArrayBuffer(16)));
  });
});

describe('parseAnatomyGLTF', () => {
  const { parseAnatomyGLTF } = createMeshParsers(createLoaders());

  test('keeps node names and the file materials, computes normals, turns culling off', async () => {
    const scene = await parseAnatomyGLTF(glbWithNodes(['sclera', 'cornea', 'lens']));
    const meshes = meshesOf(scene);
    assert.equal(meshes.length, 3);
    assert.deepEqual(meshes.map((m) => m.name).sort(), ['cornea', 'lens', 'sclera']);
    for (const m of meshes) {
      assert.equal(m.frustumCulled, false);
      assert.ok(m.geometry.attributes.normal, 'normals computed');
      assert.equal(m.material.name, `${m.name}_mat`, 'file material preserved');
    }
  });

  test('leaves the meshes with distinct material instances', async () => {
    const scene = await parseAnatomyGLTF(glbWithNodes(['a', 'b']));
    const [x, y] = meshesOf(scene);
    assert.notEqual(x.material, y.material);
  });

  test('rejects on a buffer that is not a GLB', async () => {
    await assert.rejects(parseAnatomyGLTF(new ArrayBuffer(16)));
  });
});

describe('createMeshParsers', () => {
  test('uses the loaders it is given', async () => {
    const loaders = createLoaders();
    let stlCalls = 0;
    let gltfCalls = 0;
    const origStl = loaders.stlLoader.parse.bind(loaders.stlLoader);
    const origGltf = loaders.gltfLoader.parse.bind(loaders.gltfLoader);
    loaders.stlLoader.parse = (...a) => { stlCalls++; return origStl(...a); };
    loaders.gltfLoader.parse = (...a) => { gltfCalls++; return origGltf(...a); };
    const parsers = createMeshParsers(loaders);
    parsers.parseSTL(binarySTL(1), { color: 0xffffff, opacity: 1 });
    await parsers.parseGLTF(glbWithNodes(['a']));
    await parsers.parseAnatomyGLTF(glbWithNodes(['a']));
    assert.equal(stlCalls, 1);
    assert.equal(gltfCalls, 2);
  });
});
