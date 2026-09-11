// ============================================================================
//  Tests for core/materials.js — the material recipe (opaque vs translucent
//  flags), recolouring and re-opacifying an object tree including the
//  `noClip` exemption, and disposal of geometry and single/array materials.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeMaterial, applyColor, setObjectOpacity, disposeObject } from '../../core/materials.js';
import { namedBoxGroup } from '../helpers/fixtures.js';

describe('makeMaterial', () => {
  test('opaque: not transparent, writes depth, double-sided, roughness 0.82, metalness 0', () => {
    const m = makeMaterial(0x336699, 1);
    assert.ok(m.isMeshStandardMaterial);
    assert.equal(m.color.getHex(), 0x336699);
    assert.equal(m.opacity, 1);
    assert.equal(m.transparent, false);
    assert.equal(m.depthWrite, true);
    assert.equal(m.side, THREE.DoubleSide);
    assert.equal(m.roughness, 0.82);
    assert.equal(m.metalness, 0);
  });

  test('translucent: transparent and no depth write', () => {
    const m = makeMaterial(0xff0000, 0.4);
    assert.equal(m.opacity, 0.4);
    assert.equal(m.transparent, true);
    assert.equal(m.depthWrite, false);
    assert.equal(m.side, THREE.DoubleSide);
  });

  test('every call returns a fresh material', () => {
    assert.notEqual(makeMaterial(0xffffff, 1), makeMaterial(0xffffff, 1));
  });
});

describe('applyColor', () => {
  test('recolours every mesh in a nested group, leaving non-meshes alone', () => {
    const outer = new THREE.Group();
    const inner = namedBoxGroup(['a', 'b']);
    outer.add(inner);
    outer.add(new THREE.Object3D());
    applyColor(outer, 0x123456);
    for (const mesh of inner.children) assert.equal(mesh.material.color.getHex(), 0x123456, mesh.name);
  });

  test('skips a mesh without a material', () => {
    const g = new THREE.Group();
    const bare = new THREE.Mesh(new THREE.BoxGeometry());
    bare.material = null;
    g.add(bare);
    assert.doesNotThrow(() => applyColor(g, 0xabcdef));
  });
});

describe('setObjectOpacity', () => {
  test('translucent value: opacity, transparent, no depthWrite, renderOrder 1, needsUpdate', () => {
    const g = namedBoxGroup(['a']);
    const [mesh] = g.children;
    const before = mesh.material.version;
    setObjectOpacity(g, 0.3);
    assert.equal(mesh.material.opacity, 0.3);
    assert.equal(mesh.material.transparent, true);
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.renderOrder, 1);
    assert.equal(mesh.material.version, before + 1);   // needsUpdate = true bumps the version
  });

  test('opaque value: renderOrder falls back to 0 and depth is written again', () => {
    const g = namedBoxGroup(['a']);
    const [mesh] = g.children;
    setObjectOpacity(g, 0.3);
    setObjectOpacity(g, 1);
    assert.equal(mesh.material.opacity, 1);
    assert.equal(mesh.material.transparent, false);
    assert.equal(mesh.material.depthWrite, true);
    assert.equal(mesh.renderOrder, 0);
  });

  test('skips meshes flagged userData.noClip (cap coats keep their own settings)', () => {
    const g = namedBoxGroup(['cap', 'coat']);
    const [cap, coat] = g.children;
    cap.userData.noClip = true;
    cap.renderOrder = 100;
    setObjectOpacity(g, 0.5);
    assert.equal(cap.material.opacity, 1);
    assert.equal(cap.material.transparent, false);
    assert.equal(cap.renderOrder, 100);
    assert.equal(coat.material.opacity, 0.5);
    assert.equal(coat.renderOrder, 1);
  });
});

describe('disposeObject', () => {
  test('disposes each mesh geometry and single material', () => {
    const g = namedBoxGroup(['a', 'b']);
    const calls = [];
    for (const mesh of g.children) {
      mesh.geometry.dispose = () => calls.push(`geo:${mesh.name}`);
      mesh.material.dispose = () => calls.push(`mat:${mesh.name}`);
    }
    disposeObject(g);
    assert.deepEqual(calls.sort(), ['geo:a', 'geo:b', 'mat:a', 'mat:b']);
  });

  test('disposes every entry of an array material', () => {
    const g = namedBoxGroup(['multi']);
    const [mesh] = g.children;
    const calls = [];
    mesh.geometry.dispose = () => calls.push('geo');
    mesh.material = [0, 1, 2].map((i) => ({ dispose: () => calls.push(`mat${i}`) }));
    disposeObject(g);
    assert.deepEqual(calls, ['geo', 'mat0', 'mat1', 'mat2']);
  });

  test('tolerates a mesh with no geometry or material and ignores non-meshes', () => {
    const g = new THREE.Group();
    const bare = new THREE.Mesh();
    bare.geometry = null; bare.material = null;
    g.add(bare, new THREE.Object3D());
    assert.doesNotThrow(() => disposeObject(g));
  });
});
