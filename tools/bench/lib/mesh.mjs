// ============================================================================
//  mesh.mjs — read the two mesh formats this project moves between: the binary
//  STL that 3D Slicer exports, and the Draco-compressed GLB the viewer ships.
//  Both are returned in the same shape so they can be compared directly.
// ============================================================================

import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

/**
 * @typedef {object} Mesh
 * @property {Float32Array} positions flat xyz, 3 floats per vertex
 * @property {Uint32Array}  indices   3 per triangle
 * @property {number}       triCount
 * @property {number}       vertCount
 */

/** Read a binary STL. Each triangle carries its own 3 vertices (unindexed). */
export function readSTL(path) {
  const buf = fs.readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const expected = 84 + dv.getUint32(80, true) * 50;
  if (buf.byteLength < 84 || expected !== buf.byteLength) {
    throw new Error(`${path}: not a binary STL (expected ${expected} bytes, got ${buf.byteLength})`);
  }
  const triCount = dv.getUint32(80, true);

  const positions = new Float32Array(triCount * 9);
  let p = 0;
  for (let i = 0; i < triCount; i++) {
    const base = 84 + i * 50 + 12;            // skip header, count, facet normal
    for (let j = 0; j < 9; j++) positions[p++] = dv.getFloat32(base + j * 4, true);
  }
  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;

  return { positions, indices, triCount, vertCount: triCount * 3 };
}

let io;
async function getIO() {
  io ??= new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
  return io;
}

/**
 * Read a GLB, decoding Draco if present, and merge every primitive in the file
 * into one mesh (the viewer's assets are single-object, but anatomy models hold
 * one primitive per named structure).
 * @returns {Promise<Mesh & {primitives: number, draco: boolean}>}
 */
export async function readGLB(path) {
  const doc = await (await getIO()).read(path);
  const root = doc.getRoot();
  const draco = root.listExtensionsUsed().some((e) => e.extensionName === KHRDracoMeshCompression.EXTENSION_NAME);

  const chunks = [];
  let vertTotal = 0;
  let triTotal = 0;
  let primitives = 0;

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const verts = pos.getArray();
      const idxAcc = prim.getIndices();
      // Unindexed primitives are an implicit 0..n-1 triangle soup.
      const idx = idxAcc
        ? Uint32Array.from(idxAcc.getArray())
        : Uint32Array.from({ length: pos.getCount() }, (_, i) => i);

      chunks.push({ verts, idx, offset: vertTotal });
      vertTotal += pos.getCount();
      triTotal += idx.length / 3;
      primitives++;
    }
  }

  const positions = new Float32Array(vertTotal * 3);
  const indices = new Uint32Array(triTotal * 3);
  let vp = 0;
  let ip = 0;
  for (const { verts, idx, offset } of chunks) {
    positions.set(verts, vp);
    vp += verts.length;
    for (let i = 0; i < idx.length; i++) indices[ip++] = idx[i] + offset;
  }

  return { positions, indices, triCount: triTotal, vertCount: vertTotal, primitives, draco };
}

/** Dispatch on file extension. */
export function readMesh(path) {
  return /\.stl$/i.test(path) ? readSTL(path) : readGLB(path);
}

/** Axis-aligned bounds and the bounding-box diagonal used to normalise errors. */
export function bounds({ positions }) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const d = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return { min, max, diagonal: d };
}

/** Total surface area — a cheap sanity check that decimation kept the shape. */
export function surfaceArea({ positions, indices }) {
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return area;
}
