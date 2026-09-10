// ============================================================================
//  grid.mjs — a uniform spatial hash over triangles, supporting exact
//  point-to-surface distance queries. Used to measure how far the decimated
//  mesh strays from the original scan surface.
//
//  Triangles are binned by centroid (so storage is exactly one reference per
//  triangle, which matters at 21M triangles) and the largest centroid-to-vertex
//  radius in the mesh is carried alongside, so shell search can still terminate
//  with a guarantee rather than a heuristic.
// ============================================================================

/** Squared distance from point p to the triangle (a,b,c). Ericson, RTCD §5.1.5. */
export function pointTriangleDistSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;   // vertex A

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;  // vertex B

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;  // vertex C

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {                                // edge AB
    const t = d1 / (d1 - d3);
    const qx = apx - t * abx, qy = apy - t * aby, qz = apz - t * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {                                // edge AC
    const t = d2 / (d2 - d6);
    const qx = apx - t * acx, qy = apy - t * acy, qz = apz - t * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {                      // edge BC
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx + t * (cpx - bpx), qy = bpy + t * (cpy - bpy), qz = bpz + t * (cpz - bpz);
    return qx * qx + qy * qy + qz * qz;
  }
  // Interior — project onto the plane via barycentric coordinates.
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const qx = apx - (abx * v + acx * w);
  const qy = apy - (aby * v + acy * w);
  const qz = apz - (abz * v + acz * w);
  return qx * qx + qy * qy + qz * qz;
}

export class TriangleGrid {
  /**
   * @param {{positions: Float32Array, indices: Uint32Array, triCount: number}} mesh
   * @param {number} [targetPerCell] average triangles per occupied cell
   */
  constructor(mesh, targetPerCell = 4) {
    const { positions, indices, triCount } = mesh;
    this.positions = positions;
    this.indices = indices;
    this.triCount = triCount;

    // --- bounds -------------------------------------------------------------
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const vol = Math.max(ext[0] * ext[1] * ext[2], Number.EPSILON);
    // Cell edge chosen so an average cell holds ~targetPerCell triangles.
    let cell = Math.cbrt((vol * targetPerCell) / Math.max(triCount, 1));
    if (!Number.isFinite(cell) || cell <= 0) cell = Math.max(...ext) || 1;

    this.min = min;
    this.cell = cell;
    this.dim = ext.map((e) => Math.max(1, Math.min(512, Math.floor(e / cell) + 1)));
    // Recompute the effective cell edge per axis after clamping the resolution.
    this.step = ext.map((e, a) => (e || 1) / this.dim[a]);

    const [nx, ny, nz] = this.dim;
    const nCells = nx * ny * nz;

    // --- bin triangles by centroid into a CSR layout ------------------------
    const cellOf = new Int32Array(triCount);
    const counts = new Int32Array(nCells + 1);
    let maxRadiusSq = 0;

    for (let t = 0; t < triCount; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const gx = (positions[a] + positions[b] + positions[c]) / 3;
      const gy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
      const gz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;

      for (const v of [a, b, c]) {
        const dx = positions[v] - gx, dy = positions[v + 1] - gy, dz = positions[v + 2] - gz;
        const r = dx * dx + dy * dy + dz * dz;
        if (r > maxRadiusSq) maxRadiusSq = r;
      }

      const ix = this._clampAxis(gx, 0), iy = this._clampAxis(gy, 1), iz = this._clampAxis(gz, 2);
      const idx = (iz * ny + iy) * nx + ix;
      cellOf[t] = idx;
      counts[idx + 1]++;
    }
    for (let i = 1; i <= nCells; i++) counts[i] += counts[i - 1];

    const items = new Int32Array(triCount);
    const cursor = counts.slice(0, nCells);
    for (let t = 0; t < triCount; t++) items[cursor[cellOf[t]]++] = t;

    this.starts = counts;
    this.items = items;
    this.maxRadius = Math.sqrt(maxRadiusSq);
  }

  _clampAxis(v, a) {
    const i = Math.floor((v - this.min[a]) / this.step[a]);
    return i < 0 ? 0 : i >= this.dim[a] ? this.dim[a] - 1 : i;
  }

  /**
   * Exact distance from a point to the nearest triangle surface.
   * Expands cell shells outward, stopping once no unvisited cell could hold a
   * triangle closer than the best found so far.
   */
  distanceTo(px, py, pz) {
    const [nx, ny, nz] = this.dim;
    const { starts, items, indices, positions } = this;
    const cx = this._clampAxis(px, 0), cy = this._clampAxis(py, 1), cz = this._clampAxis(pz, 2);
    const minStep = Math.min(this.step[0], this.step[1], this.step[2]);
    const maxShell = Math.max(nx, ny, nz);

    let best = Infinity;
    for (let r = 0; r <= maxShell; r++) {
      // Nothing in shell r can beat `best` once the shell's closest possible
      // centroid is further away than best + the largest triangle radius.
      if (best < Infinity && (r - 1) * minStep - this.maxRadius > Math.sqrt(best)) break;

      const x0 = Math.max(0, cx - r), x1 = Math.min(nx - 1, cx + r);
      const y0 = Math.max(0, cy - r), y1 = Math.min(ny - 1, cy + r);
      const z0 = Math.max(0, cz - r), z1 = Math.min(nz - 1, cz + r);

      for (let z = z0; z <= z1; z++) {
        const onZ = z === cz - r || z === cz + r;
        for (let y = y0; y <= y1; y++) {
          const onY = y === cy - r || y === cy + r;
          // Only walk the surface of the shell; the interior was done already.
          const xs = (onZ || onY)
            ? null                                  // full row
            : [cx - r, cx + r].filter((x) => x >= 0 && x < nx);
          const row = (z * ny + y) * nx;

          if (xs === null) {
            for (let x = x0; x <= x1; x++) best = this._scanCell(row + x, px, py, pz, best);
          } else {
            for (const x of xs) best = this._scanCell(row + x, px, py, pz, best);
          }
        }
      }
    }
    return Math.sqrt(best);
  }

  _scanCell(cellIdx, px, py, pz, best) {
    const { starts, items, indices, positions } = this;
    const s = starts[cellIdx], e = starts[cellIdx + 1];
    for (let k = s; k < e; k++) {
      const t = items[k] * 3;
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const d = pointTriangleDistSq(
        px, py, pz,
        positions[a], positions[a + 1], positions[a + 2],
        positions[b], positions[b + 1], positions[b + 2],
        positions[c], positions[c + 1], positions[c + 2],
      );
      if (d < best) best = d;
    }
    return best;
  }
}

/**
 * Deterministically sample points spread over a mesh's surface, area-weighted
 * so large triangles receive proportionally more samples.
 * @returns {Float32Array} flat xyz
 */
export function sampleSurface({ positions, indices }, count, seed = 12345) {
  const triCount = indices.length / 3;
  const cum = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    cum[t] = total;
  }

  // mulberry32 — small, fast, reproducible.
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Binary search the area CDF.
    const target = rnd() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }

    const a = indices[lo * 3] * 3, b = indices[lo * 3 + 1] * 3, c = indices[lo * 3 + 2] * 3;
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    out[i * 3] = w * positions[a] + u * positions[b] + v * positions[c];
    out[i * 3 + 1] = w * positions[a + 1] + u * positions[b + 1] + v * positions[c + 1];
    out[i * 3 + 2] = w * positions[a + 2] + u * positions[b + 2] + v * positions[c + 2];
  }
  return out;
}
