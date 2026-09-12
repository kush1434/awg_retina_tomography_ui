// ============================================================================
//  fixtures.js — in-memory meshes and an io stub for the core unit tests.
//  Every shipped .glb is Draco-compressed and Draco cannot decode headless, so
//  the core is exercised with a tiny binary STL and a hand-written,
//  uncompressed GLB that `GLTFLoader.parse` accepts with node names intact.
// ============================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------------------
//  Geometry
// ---------------------------------------------------------------------------

/**
 * A binary STL of `n` triangles. Triangle i is a unit right triangle in the
 * XY plane lifted to z = i, so the bounding box grows with `n`.
 * @param {number} n
 * @returns {ArrayBuffer}
 */
export function binarySTL(n = 1) {
  const buf = new ArrayBuffer(80 + 4 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let off = 84;
  for (let i = 0; i < n; i++) {
    const tri = [
      [0, 0, 1],                          // normal
      [0, 0, i], [1, 0, i], [0, 1, i],    // vertices
    ];
    for (const v of tri) for (const c of v) { dv.setFloat32(off, c, true); off += 4; }
    dv.setUint16(off, 0, true); off += 2;  // attribute byte count
  }
  return buf;
}

/**
 * An uncompressed GLB whose scene has one named node per entry of `names`,
 * each carrying a single-triangle mesh (with a normal attribute when
 * `normals` is set) and its own material. Written as JSON + BIN chunks per
 * the glTF 2.0 spec.
 *
 * `assetVersion` writes a different `asset.version`: a structurally valid GLB
 * declaring '1.0' is the one failure GLTFLoader reports through its onError
 * callback instead of throwing, which is how the shipped Draco files fail too.
 * A parser that dropped its `reject` would hang on it rather than reject.
 *
 * @param {string[]} names
 * @param {{ normals?: boolean, assetVersion?: string }} [opts]
 * @returns {ArrayBuffer}
 */
export function glbWithNodes(names, { normals = false, assetVersion = '2.0' } = {}) {
  const POS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const NRM = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const stride = POS.byteLength + (normals ? NRM.byteLength : 0);

  const bin = new Uint8Array(stride * names.length);
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const materials = [];
  const nodes = [];

  names.forEach((name, i) => {
    const base = i * stride;
    // Offset each node's triangle along z so the meshes are distinguishable.
    const pos = POS.slice();
    for (let k = 2; k < pos.length; k += 3) pos[k] = i;
    bin.set(new Uint8Array(pos.buffer), base);
    bufferViews.push({ buffer: 0, byteOffset: base, byteLength: POS.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1, componentType: 5126, count: 3, type: 'VEC3',
      min: [0, 0, i], max: [1, 1, i],
    });
    const attributes = { POSITION: accessors.length - 1 };
    if (normals) {
      bin.set(new Uint8Array(NRM.buffer), base + POS.byteLength);
      bufferViews.push({ buffer: 0, byteOffset: base + POS.byteLength, byteLength: NRM.byteLength });
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 3, type: 'VEC3' });
      attributes.NORMAL = accessors.length - 1;
    }
    materials.push({ name: `${name}_mat`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } });
    meshes.push({ name: `${name}_mesh`, primitives: [{ attributes, material: i }] });
    nodes.push({ name, mesh: i });
  });

  const json = {
    asset: { version: assetVersion, generator: 'fixtures.js' },
    scene: 0,
    scenes: [{ nodes: names.map((_, i) => i) }],
    nodes, meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };

  // Chunks are 4-byte aligned: JSON padded with spaces, BIN with zeros.
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const binPad = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + bin.byteLength + binPad;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  dv.setUint32(off, 0x46546C67, true); off += 4;       // 'glTF'
  dv.setUint32(off, 2, true); off += 4;                // version
  dv.setUint32(off, total, true); off += 4;
  dv.setUint32(off, jsonBytes.byteLength + jsonPad, true); off += 4;
  dv.setUint32(off, 0x4E4F534A, true); off += 4;       // 'JSON'
  out.set(jsonBytes, off); off += jsonBytes.byteLength;
  out.fill(0x20, off, off + jsonPad); off += jsonPad;
  dv.setUint32(off, bin.byteLength + binPad, true); off += 4;
  dv.setUint32(off, 0x004E4942, true); off += 4;       // 'BIN\0'
  out.set(bin, off);
  return out.buffer;
}

/**
 * A THREE.Group holding one unit BoxGeometry mesh per name (mesh.name = name),
 * each shifted along x so the union box is `names.length` wide.
 * @param {string[]} names
 * @returns {THREE.Group}
 */
export function namedBoxGroup(names) {
  const group = new THREE.Group();
  names.forEach((name, i) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.name = name;
    mesh.position.x = i;
    group.add(mesh);
  });
  return group;
}

// ---------------------------------------------------------------------------
//  io stub
// ---------------------------------------------------------------------------

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  throw new TypeError('stubIo route values must be ArrayBuffer or typed array');
}

/**
 * An in-memory stand-in for asset-loader.js's `{ fetchBuffer, isCached }`.
 *
 * Routes map a URL to its bytes. A URL listed in `cached` resolves after one
 * `{ fromCache: true }` progress tick, mirroring the Cache Storage hit path;
 * any other known URL yields `progressTicks` evenly spaced progress ticks
 * (each after a macrotask, so a caller can `abort()` between them) and then
 * the bytes. An unknown URL rejects like a 404; an aborted signal rejects
 * with an AbortError, before the first tick or between ticks.
 *
 * `hideTotal` reports every tick with `total: 0`, the way asset-loader.js does
 * for a chunked response that carries no Content-Length (:44) — the case a
 * progress percentage must not turn into NaN over.
 *
 * @param {Record<string, ArrayBuffer|ArrayBufferView> & { cached?: Set<string>|string[], progressTicks?: number, hideTotal?: boolean }} [routes]
 * @returns {{ fetchBuffer: Function, isCached: Function, calls: Array<{url: string, fromCache: boolean}> }}
 */
export function stubIo(routes = {}) {
  const { cached = new Set(), progressTicks = 2, hideTotal = false, ...table } = routes;
  const cachedSet = cached instanceof Set ? cached : new Set(cached);
  const calls = [];

  async function fetchBuffer(url, { onProgress, signal } = {}) {
    if (signal?.aborted) throw abortError();
    const data = table[url];
    if (data === undefined) throw new Error('HTTP 404 Not Found');
    const buf = toArrayBuffer(data);
    const total = buf.byteLength;
    const fromCache = cachedSet.has(url);
    calls.push({ url, fromCache });

    if (fromCache) {
      onProgress?.({ loaded: total, total, fromCache: true });
      return buf;
    }

    const yieldTick = () => new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 0);
    });

    const ticks = Math.max(1, progressTicks | 0);
    for (let i = 1; i <= ticks; i++) {
      await yieldTick();
      if (signal?.aborted) throw abortError();
      onProgress?.({ loaded: Math.round((total * i) / ticks), total: hideTotal ? 0 : total });
    }
    return buf;
  }

  async function isCached(url) { return cachedSet.has(url); }

  return { fetchBuffer, isCached, calls };
}
