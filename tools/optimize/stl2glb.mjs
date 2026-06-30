// Convert a binary STL (3D Slicer output) into a minimal GLB (positions only).
// Normals are recomputed in the browser after decimation. Usage:
//   node --max-old-space-size=16384 stl2glb.mjs <in.stl> <out.glb>
import fs from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('usage: stl2glb.mjs <in.stl> <out.glb>'); process.exit(1); }

const buf = fs.readFileSync(inPath);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

// Binary STL: 80-byte header, uint32 triangle count, then 50 bytes/triangle.
const triCount = dv.getUint32(80, true);
console.log(`${inPath}: ${triCount.toLocaleString()} triangles`);

const positions = new Float32Array(triCount * 9);
let p = 0;
for (let i = 0; i < triCount; i++) {
  const base = 84 + i * 50 + 12; // skip 80 header + 4 count + 12 normal
  for (let j = 0; j < 9; j++) positions[p++] = dv.getFloat32(base + j * 4, true);
  if (i % 4_000_000 === 0 && i) console.log(`  parsed ${i.toLocaleString()}…`);
}

const doc = new Document();
const gbuf = doc.createBuffer();
const pos = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(gbuf);
const prim = doc.createPrimitive().setAttribute('POSITION', pos);
const mesh = doc.createMesh().addPrimitive(prim);
const node = doc.createNode().setMesh(mesh);
doc.createScene().addChild(node);

await new NodeIO().write(outPath, doc);
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`);
