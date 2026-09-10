// ============================================================================
//  Tests for tools/bench/lib/grid.mjs — the point-to-surface distance machinery
//  behind the reported decimation error. The grid is only useful if it agrees
//  with brute force, so that is what these check.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointTriangleDistSq, TriangleGrid, sampleSurface,
} from '../tools/bench/lib/grid.mjs';

const dist = (...a) => Math.sqrt(pointTriangleDistSq(...a));
/** The unit right triangle in the z = 0 plane. */
const T = [0, 0, 0, 1, 0, 0, 0, 1, 0];

/** Brute-force nearest-surface distance, for cross-checking the grid. */
function bruteForce({ positions, indices }, px, py, pz) {
  let best = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const d = pointTriangleDistSq(
      px, py, pz,
      positions[a], positions[a + 1], positions[a + 2],
      positions[b], positions[b + 1], positions[b + 2],
      positions[c], positions[c + 1], positions[c + 2],
    );
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** mulberry32, so the generated meshes are identical on every run. */
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A closed-ish shell of random triangles on a sphere — cheap stand-in for a scan. */
function sphereMesh(triCount, radius = 10, seed = 3) {
  const r = rng(seed);
  const positions = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    // A small random triangle tangent to the sphere at a random point.
    const u = r() * 2 - 1, phi = r() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const cx = radius * s * Math.cos(phi), cy = radius * s * Math.sin(phi), cz = radius * u;
    for (let v = 0; v < 3; v++) {
      positions[t * 9 + v * 3] = cx + (r() - 0.5) * 1.5;
      positions[t * 9 + v * 3 + 1] = cy + (r() - 0.5) * 1.5;
      positions[t * 9 + v * 3 + 2] = cz + (r() - 0.5) * 1.5;
    }
  }
  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices, triCount, vertCount: triCount * 3 };
}

describe('pointTriangleDistSq', () => {
  test('is zero on the surface', () => {
    assert.equal(dist(0, 0, 0, ...T), 0, 'at a vertex');
    assert.equal(dist(0.5, 0.5, 0, ...T), 0, 'on the hypotenuse');
    assert.ok(dist(0.25, 0.25, 0, ...T) < 1e-6, 'inside the face');
  });

  test('measures perpendicular distance above the face', () => {
    assert.ok(Math.abs(dist(0.25, 0.25, 2, ...T) - 2) < 1e-6);
    assert.ok(Math.abs(dist(0.25, 0.25, -3, ...T) - 3) < 1e-6, 'sign of the offset does not matter');
  });

  test('clamps to the nearest vertex outside the corners', () => {
    assert.ok(Math.abs(dist(-1, 0, 0, ...T) - 1) < 1e-6, 'past vertex A');
    assert.ok(Math.abs(dist(3, 0, 0, ...T) - 2) < 1e-6, 'past vertex B');
    assert.ok(Math.abs(dist(0, 4, 0, ...T) - 3) < 1e-6, 'past vertex C');
    assert.ok(Math.abs(dist(-3, -4, 0, ...T) - 5) < 1e-6, 'diagonally past A');
  });

  test('clamps to the nearest edge outside an edge', () => {
    assert.ok(Math.abs(dist(0.5, -2, 0, ...T) - 2) < 1e-6, 'beyond edge AB');
    assert.ok(Math.abs(dist(-2, 0.5, 0, ...T) - 2) < 1e-6, 'beyond edge AC');
    const expected = Math.SQRT1_2;  // perpendicular from (1,1,0) to x + y = 1
    assert.ok(Math.abs(dist(1, 1, 0, ...T) - expected) < 1e-6, 'beyond edge BC');
  });

  test('combines in-plane and out-of-plane offsets', () => {
    // 3 units past vertex A in x, 4 units above the plane.
    assert.ok(Math.abs(dist(-3, 0, 4, ...T) - 5) < 1e-6);
  });

  test('is robust to a degenerate (zero-area) triangle', () => {
    const d = dist(0, 0, 5, 0, 0, 0, 1, 0, 0, 2, 0, 0);  // collinear
    assert.ok(Number.isFinite(d) && Math.abs(d - 5) < 1e-6);
  });
});

describe('TriangleGrid', () => {
  test('agrees with brute force on every probe point', () => {
    const mesh = sphereMesh(4000);
    const grid = new TriangleGrid(mesh);
    const r = rng(99);

    for (let i = 0; i < 300; i++) {
      // Probe inside, on, and well outside the shell.
      const p = [(r() - 0.5) * 30, (r() - 0.5) * 30, (r() - 0.5) * 30];
      const got = grid.distanceTo(...p);
      const want = bruteForce(mesh, ...p);
      assert.ok(Math.abs(got - want) < 1e-4,
        `at (${p.map((v) => v.toFixed(2))}): grid ${got} vs brute force ${want}`);
    }
  });

  test('returns zero for points lying on the surface', () => {
    const mesh = sphereMesh(2000);
    const grid = new TriangleGrid(mesh);
    const pts = sampleSurface(mesh, 200, 5);
    for (let i = 0; i < 200; i++) {
      assert.ok(grid.distanceTo(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]) < 1e-3);
    }
  });

  test('handles a far-away query without missing the mesh', () => {
    const mesh = sphereMesh(500);
    const grid = new TriangleGrid(mesh);
    const got = grid.distanceTo(1000, 1000, 1000);
    assert.ok(Math.abs(got - bruteForce(mesh, 1000, 1000, 1000)) < 1e-3);
  });

  test('copes with a planar mesh of zero thickness', () => {
    // A flat sheet collapses one axis of the grid; the search must still work.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const mesh = { positions, indices, triCount: 2, vertCount: 6 };
    const grid = new TriangleGrid(mesh);
    assert.ok(Math.abs(grid.distanceTo(0.5, 0.5, 3) - 3) < 1e-6);
  });

  test('handles a single-triangle mesh', () => {
    const mesh = { positions: Float32Array.from(T), indices: new Uint32Array([0, 1, 2]), triCount: 1, vertCount: 3 };
    const grid = new TriangleGrid(mesh);
    assert.ok(Math.abs(grid.distanceTo(0.25, 0.25, 2) - 2) < 1e-6);
  });
});

describe('sampleSurface', () => {
  test('places every sample on the mesh surface', () => {
    const mesh = sphereMesh(1500);
    const grid = new TriangleGrid(mesh);
    const pts = sampleSurface(mesh, 500, 11);
    let worst = 0;
    for (let i = 0; i < 500; i++) {
      worst = Math.max(worst, grid.distanceTo(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
    }
    assert.ok(worst < 1e-3, `worst off-surface distance ${worst}`);
  });

  test('is deterministic for a given seed', () => {
    const mesh = sphereMesh(300);
    assert.deepEqual(sampleSurface(mesh, 100, 42), sampleSurface(mesh, 100, 42));
    assert.notDeepEqual(sampleSurface(mesh, 100, 42), sampleSurface(mesh, 100, 43));
  });

  test('weights by area, not by triangle count', () => {
    // One triangle 100x the area of the other; samples should follow the area.
    const positions = new Float32Array([
      0, 0, 0, 10, 0, 0, 0, 10, 0,      // area 50
      100, 0, 0, 101, 0, 0, 100, 1, 0,  // area 0.5
    ]);
    const mesh = {
      positions, indices: new Uint32Array([0, 1, 2, 3, 4, 5]), triCount: 2, vertCount: 6,
    };
    const pts = sampleSurface(mesh, 4000, 21);
    let onBig = 0;
    for (let i = 0; i < 4000; i++) if (pts[i * 3] < 50) onBig++;
    const share = onBig / 4000;
    assert.ok(share > 0.97 && share < 1.0, `expected ~99% on the large triangle, got ${(share * 100).toFixed(1)}%`);
  });

  test('produces the requested number of points', () => {
    const mesh = sphereMesh(50);
    assert.equal(sampleSurface(mesh, 777, 1).length, 777 * 3);
  });
});
