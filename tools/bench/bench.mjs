#!/usr/bin/env node
// ============================================================================
//  bench.mjs — measures what the optimization pipeline actually costs and buys.
//
//    node bench.mjs                          inventory of the shipped assets
//    node bench.mjs --json                   the same, machine-readable
//    node bench.mjs --verify <src> <opt>     geometric error of a decimation
//
//  The inventory runs against the repository as checked out. `--verify` needs
//  the full-resolution source mesh, which lives in the Hugging Face dataset
//  rather than in git — see tools/bench/README.md.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMesh, readGLB, bounds, surfaceArea } from './lib/mesh.mjs';
import { TriangleGrid, sampleSurface } from './lib/grid.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KB = 1024;

const fmtBytes = (n) => (n >= KB * KB ? `${(n / KB / KB).toFixed(1)} MB` : `${(n / KB).toFixed(0)} KB`);
const fmtNum = (n) => n.toLocaleString('en-US');

/** Every GLB the app can serve from its own origin, grouped by role. */
function shippedAssets() {
  const groups = {
    'Segmented layers (sample 1)': 'optimized/sample_1_seg_mesh',
    'Segmented layers (F10)': 'optimized/F10_layers',
    'Segmented layers (F10, solid fill)': 'optimized/F10_layers_solid',
    'Reference anatomy': 'optimized/anatomy',
  };
  const out = [];
  for (const [group, rel] of Object.entries(groups)) {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort()) {
      out.push({ group, rel: path.join(rel, f), abs: path.join(dir, f) });
    }
  }
  return out;
}

async function inventory({ json }) {
  const rows = [];
  for (const a of shippedAssets()) {
    const bytes = fs.statSync(a.abs).size;
    const mesh = await readGLB(a.abs);
    rows.push({
      group: a.group,
      file: a.rel,
      bytes,
      triangles: mesh.triCount,
      vertices: mesh.vertCount,
      primitives: mesh.primitives,
      draco: mesh.draco,
      bytesPerTriangle: +(bytes / mesh.triCount).toFixed(2),
    });
  }

  if (json) { console.log(JSON.stringify({ generated: new Date().toISOString(), assets: rows }, null, 2)); return; }

  let group = null;
  console.log('\nShipped assets\n');
  console.log('  file                                        size   triangles  vertices  B/tri  draco');
  console.log('  ' + '-'.repeat(88));
  for (const r of rows) {
    if (r.group !== group) { group = r.group; console.log(`\n  ${group}`); }
    console.log(
      `  ${path.basename(r.file).padEnd(36)}${fmtBytes(r.bytes).padStart(10)}`
      + `${fmtNum(r.triangles).padStart(12)}${fmtNum(r.vertices).padStart(10)}`
      + `${String(r.bytesPerTriangle).padStart(7)}${(r.draco ? 'yes' : 'no').padStart(7)}`,
    );
  }

  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const tris = rows.reduce((n, r) => n + r.triangles, 0);
  console.log('\n  ' + '-'.repeat(88));
  console.log(`  ${String(rows.length).padStart(2)} assets${fmtBytes(total).padStart(37)}${fmtNum(tris).padStart(12)}\n`);

  // What a visitor actually pays for on a first visit: the app shell plus the
  // default anatomy model. Segmented layers stream in only when toggled.
  // The shell is resolved by walking index.html's actual module graph rather
  // than a hard-coded list — a list silently goes stale whenever a module moves,
  // and this figure is published in the paper.
  const shell = appShellFiles().reduce((n, p) => n + fs.statSync(p).size, 0);
  const anatomy = rows.find((r) => r.file.endsWith('eye-anatomy.glb'));
  console.log(`  First paint    app shell ${fmtBytes(shell)} + default anatomy ${fmtBytes(anatomy?.bytes ?? 0)}`
    + ` = ${fmtBytes(shell + (anatomy?.bytes ?? 0))}`);
  console.log(`  Everything     ${fmtBytes(shell + total)} if every layer is toggled on\n`);
}

/**
 * Every same-origin file the browser fetches before the first frame: index.html,
 * its stylesheets, and the transitive closure of relative imports from its
 * module entry points. Bare specifiers (`three`, `three/addons/`) resolve to a
 * CDN through the import map and are deliberately excluded — they are not served
 * from this repository.
 */
function appShellFiles() {
  const entry = path.join(ROOT, 'index.html');
  if (!fs.existsSync(entry)) return [];
  const html = fs.readFileSync(entry, 'utf8');
  const seen = new Set([entry]);

  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)) {
    const p = resolveLocal(m[1], ROOT);
    if (p) seen.add(p);
  }

  const queue = [];
  for (const m of html.matchAll(/<script[^>]+type=["']module["'][^>]*src=["']([^"']+)["']/g)) {
    const p = resolveLocal(m[1], ROOT);
    if (p) queue.push(p);
  }

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    // static `from '...'` plus dynamic `import('...')`
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*["']([^"']+)["']/g),
      ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // bare -> CDN
      const p = resolveLocal(spec, path.dirname(file));
      if (p) queue.push(p);
    }
  }
  return [...seen];
}

/** Resolve a relative/absolute URL to a file inside the repo, or null. */
function resolveLocal(spec, from) {
  const clean = spec.split('?')[0].split('#')[0];
  if (/^https?:/.test(clean)) return null;
  const p = clean.startsWith('/') ? path.join(ROOT, clean) : path.resolve(from, clean);
  return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

/** Percentile of a sorted Float64Array. */
function pct(sorted, p) {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function stats(dists) {
  const sorted = Float64Array.from(dists).sort();
  let sum = 0, sumSq = 0;
  for (const d of dists) { sum += d; sumSq += d * d; }
  return {
    mean: sum / dists.length,
    rms: Math.sqrt(sumSq / dists.length),
    p95: pct(sorted, 0.95),
    p99: pct(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

async function verify(srcPath, optPath, { samples, json }) {
  const t0 = Date.now();
  process.stderr.write(`reading ${srcPath} …\n`);
  const src = await readMesh(srcPath);
  process.stderr.write(`reading ${optPath} …\n`);
  const opt = await readMesh(optPath);

  const srcB = bounds(src);
  const diag = srcB.diagonal;

  process.stderr.write(`indexing ${fmtNum(src.triCount)} source triangles …\n`);
  const srcGrid = new TriangleGrid(src);
  process.stderr.write(`indexing ${fmtNum(opt.triCount)} decimated triangles …\n`);
  const optGrid = new TriangleGrid(opt);

  // Symmetric: decimated -> original catches invented surface, original ->
  // decimated catches detail that was dropped. Hausdorff is the max of both.
  process.stderr.write(`sampling ${fmtNum(samples)} points per direction …\n`);
  const fwdPts = sampleSurface(opt, samples, 1);
  const revPts = sampleSurface(src, samples, 2);

  const fwd = new Float64Array(samples);
  for (let i = 0; i < samples; i++) fwd[i] = srcGrid.distanceTo(fwdPts[i * 3], fwdPts[i * 3 + 1], fwdPts[i * 3 + 2]);
  const rev = new Float64Array(samples);
  for (let i = 0; i < samples; i++) rev[i] = optGrid.distanceTo(revPts[i * 3], revPts[i * 3 + 1], revPts[i * 3 + 2]);

  const f = stats(fwd), r = stats(rev);
  const srcBytes = fs.statSync(srcPath).size;
  const optBytes = fs.statSync(optPath).size;

  const result = {
    source: { file: path.basename(srcPath), bytes: srcBytes, triangles: src.triCount },
    optimized: { file: path.basename(optPath), bytes: optBytes, triangles: opt.triCount },
    reduction: {
      bytes: +(srcBytes / optBytes).toFixed(1),
      triangles: +(src.triCount / opt.triCount).toFixed(1),
      trianglesKeptPct: +((opt.triCount / src.triCount) * 100).toFixed(3),
    },
    boundingBoxDiagonal: diag,
    surfaceAreaChangePct: +(((surfaceArea(opt) / surfaceArea(src)) - 1) * 100).toFixed(3),
    samplesPerDirection: samples,
    // Distances are reported as a fraction of the bounding-box diagonal, the
    // convention used by mesh-simplification literature.
    decimatedToOriginal: asPct(f, diag),
    originalToDecimated: asPct(r, diag),
    hausdorffPctOfDiagonal: +((Math.max(f.max, r.max) / diag) * 100).toFixed(4),
    elapsedSeconds: +((Date.now() - t0) / 1000).toFixed(1),
  };

  if (json) { console.log(JSON.stringify(result, null, 2)); return result; }

  const row = (name, s) => `  ${name.padEnd(24)}`
    + `${s.meanPct.toFixed(4).padStart(9)}${s.rmsPct.toFixed(4).padStart(9)}`
    + `${s.p95Pct.toFixed(4).padStart(9)}${s.p99Pct.toFixed(4).padStart(9)}${s.maxPct.toFixed(4).padStart(9)}`;

  console.log(`\nDecimation error — ${path.basename(srcPath)} -> ${path.basename(optPath)}\n`);
  console.log(`  ${fmtNum(src.triCount)} tri (${fmtBytes(srcBytes)})  ->  ${fmtNum(opt.triCount)} tri (${fmtBytes(optBytes)})`);
  console.log(`  ${result.reduction.bytes}x smaller, ${result.reduction.triangles}x fewer triangles `
    + `(${result.reduction.trianglesKeptPct}% kept)`);
  console.log(`  surface area change ${result.surfaceAreaChangePct >= 0 ? '+' : ''}${result.surfaceAreaChangePct}%`);
  console.log(`\n  distances as % of the ${diag.toFixed(2)}-unit bounding-box diagonal, `
    + `${fmtNum(samples)} samples/direction\n`);
  console.log('  direction                    mean      rms      p95      p99      max');
  console.log('  ' + '-'.repeat(69));
  console.log(row('decimated -> original', result.decimatedToOriginal));
  console.log(row('original -> decimated', result.originalToDecimated));
  console.log('  ' + '-'.repeat(69));
  console.log(`  symmetric Hausdorff      ${result.hausdorffPctOfDiagonal.toFixed(4)}%   `
    + `(${result.elapsedSeconds}s)\n`);
  return result;
}

const asPct = (s, diag) => ({
  mean: s.mean, rms: s.rms, p95: s.p95, p99: s.p99, max: s.max,
  meanPct: (s.mean / diag) * 100,
  rmsPct: (s.rms / diag) * 100,
  p95Pct: (s.p95 / diag) * 100,
  p99Pct: (s.p99 / diag) * 100,
  maxPct: (s.max / diag) * 100,
});

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const sIdx = argv.indexOf('--samples');
const samples = sIdx >= 0 ? Number(argv[sIdx + 1]) : 50_000;
const vIdx = argv.indexOf('--verify');

if (vIdx >= 0) {
  const [src, opt] = argv.slice(vIdx + 1).filter((a) => !a.startsWith('--'));
  if (!src || !opt) { console.error('usage: bench.mjs --verify <source.stl> <optimized.glb> [--samples N] [--json]'); process.exit(1); }
  await verify(src, opt, { samples, json });
} else {
  await inventory({ json });
}
