// ============================================================================
//  Tests for data-loader.js — manifest parsing, optimized-asset resolution and
//  the Hugging Face cold-request retry.
// ============================================================================

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setLocation, makeFetch, importFresh, withCleanGlobals,
} from './helpers/browser-env.js';

const MANIFEST_URL = 'https://example.test/manifest.csv';

const HEADER = 'sample_name,sample_link,file_name,seg_mesh_label,seg_mesh_link,notes';
const CSV = [
  HEADER,
  'F10 mouse eye,,retina.glb,Retina,local/F10/retina.glb,inner neural retina',
  'F10 mouse eye,,sclera.glb,Sclera,local/F10/sclera.glb,outer sclera',
  'Sample 1,https://hf.test/s1,eye.stl,Primary Structure,https://hf.test/resolve/main/sample_1_seg_mesh/eye.stl,',
].join('\n');

let restore;
beforeEach(() => { restore = withCleanGlobals(); setLocation('?demo=off'); });
afterEach(() => restore());

describe('formatBytes', () => {
  test('renders each magnitude with sensible precision', async () => {
    const { formatBytes } = await importFresh('data-loader.js');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.00 KB');
    assert.equal(formatBytes(103 * 1024), '103 KB');
    assert.equal(formatBytes(15 * 1024), '15.0 KB');
    assert.equal(formatBytes(1024 ** 3), '1.00 GB');
  });

  test('returns an empty string for non-sizes', async () => {
    const { formatBytes } = await importFresh('data-loader.js');
    for (const v of [0, -1, NaN, Infinity, null, undefined]) {
      assert.equal(formatBytes(v), '', `expected '' for ${v}`);
    }
  });
});

describe('fileKind', () => {
  test('recognises glTF containers', async () => {
    const { fileKind } = await importFresh('data-loader.js');
    assert.equal(fileKind('a/b/retina.glb'), 'gltf');
    assert.equal(fileKind('a/b/retina.GLTF'), 'gltf');
    assert.equal(fileKind('retina.glb?download=true'), 'gltf');
  });

  test('treats anything else as STL', async () => {
    const { fileKind } = await importFresh('data-loader.js');
    assert.equal(fileKind('eye.stl'), 'stl');
    assert.equal(fileKind('eye.STL'), 'stl');
    assert.equal(fileKind('mystery'), 'stl');
    assert.equal(fileKind(), 'stl');
  });
});

describe('deriveOptimizedURL', () => {
  test('maps a Hugging Face STL to its shipped GLB', async () => {
    const { deriveOptimizedURL } = await importFresh('data-loader.js');
    assert.equal(
      deriveOptimizedURL('https://hf.test/resolve/main/sample_1_seg_mesh/eye.stl'),
      'optimized/sample_1_seg_mesh/eye.glb',
    );
  });

  test('preserves nesting and strips query strings', async () => {
    const { deriveOptimizedURL } = await importFresh('data-loader.js');
    assert.equal(
      deriveOptimizedURL('https://hf.test/resolve/abc123/a/b/c.stl?download=true'),
      'optimized/a/b/c.glb',
    );
  });

  test('falls back to the bare path when there is no /resolve/ segment', async () => {
    const { deriveOptimizedURL } = await importFresh('data-loader.js');
    assert.equal(deriveOptimizedURL('https://host.test/x/y.stl'), 'optimized/x/y.glb');
  });

  test('returns null for assets that are not STL', async () => {
    const { deriveOptimizedURL } = await importFresh('data-loader.js');
    assert.equal(deriveOptimizedURL('local/F10/retina.glb'), null);
    assert.equal(deriveOptimizedURL(''), null);
    assert.equal(deriveOptimizedURL(), null);
  });
});

describe('loadCSVData', () => {
  test('groups rows into samples and keeps structure order', async () => {
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: CSV } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const data = await loadCSVData(MANIFEST_URL);

    assert.equal(data.samples.length, 2);
    const [f10, s1] = data.samples;
    assert.equal(f10.label, 'F10 mouse eye');
    assert.equal(f10.id, 'f10_mouse_eye', 'ids are slugified');
    assert.deepEqual(f10.structures.map((s) => s.label), ['Retina', 'Sclera']);
    assert.equal(s1.link, 'https://hf.test/s1');
    assert.equal(s1.structures[0].kind, 'stl');
    assert.equal(f10.structures[0].kind, 'gltf');
  });

  test('assigns every structure a distinct id and a colour', async () => {
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: CSV } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const data = await loadCSVData(MANIFEST_URL);
    const all = data.samples.flatMap((s) => s.structures);

    assert.equal(new Set(all.map((s) => s.id)).size, all.length);
    for (const s of all) {
      assert.ok(Number.isInteger(s.color), `${s.label} has no colour`);
      assert.equal(s.opacity, 1.0);
      assert.equal(s.bytes, null, 'sizes are probed later, not at parse time');
    }
  });

  test('honours quoted fields containing commas', async () => {
    const csv = [
      HEADER,
      'S,,a.glb,"Retina, inner",local/a.glb,"edge-detected, thresholded"',
    ].join('\n');
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: csv } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);

    assert.equal(samples[0].structures[0].label, 'Retina, inner');
    assert.equal(samples[0].structures[0].notes, 'edge-detected, thresholded');
  });

  test('unescapes doubled quotes inside a quoted field', async () => {
    const csv = [HEADER, 'S,,a.glb,"the ""outer"" coat",local/a.glb,'].join('\n');
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: csv } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);
    assert.equal(samples[0].structures[0].label, 'the "outer" coat');
  });

  test('skips malformed rows rather than failing the whole manifest', async () => {
    const csv = [
      HEADER,
      ',,orphan.glb,No sample,local/a.glb,',   // no sample_name
      'S,,,No file,local/b.glb,',              // no file_name
      'S,,c.glb,No link,,',                    // no seg_mesh_link
      'S,,d.glb,Good,local/d.glb,',            // valid
    ].join('\n');
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: csv } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);

    assert.equal(samples.length, 1);
    assert.deepEqual(samples[0].structures.map((s) => s.label), ['Good']);
  });

  test('falls back to the file name when no label column value is present', async () => {
    const csv = [HEADER, 'S,,retina.glb,,local/a.glb,'].join('\n');
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: csv } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);
    assert.equal(samples[0].structures[0].label, 'retina.glb');
  });

  test('tolerates CRLF line endings and a trailing blank line', async () => {
    const csv = `${HEADER}\r\nS,,a.glb,Retina,local/a.glb,\r\n\r\n`;
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: csv } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].structures.length, 1);
  });

  test('rejects a manifest with no data rows', async () => {
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: HEADER } });
    const { loadCSVData } = await importFresh('data-loader.js');
    await assert.rejects(() => loadCSVData(MANIFEST_URL), /empty/i);
  });

  test('reads the manifest URL from the ?dataset= parameter', async () => {
    const custom = 'https://elsewhere.test/other.csv';
    setLocation(`?demo=off&dataset=${encodeURIComponent(custom)}`);
    const fetchStub = makeFetch({ [custom]: { body: CSV } });
    globalThis.fetch = fetchStub;
    const { loadCSVData } = await importFresh('data-loader.js');
    await loadCSVData();
    assert.equal(fetchStub.calls[0].url, custom);
  });

  test('appends a demo copy when the manifest holds a single sample', async () => {
    const oneSample = [
      HEADER,
      'F10 mouse eye,,retina.glb,Retina,local/F10/retina.glb,',
      'F10 mouse eye,,sclera.glb,Sclera,local/F10/sclera.glb,',
    ].join('\n');
    setLocation('');
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: oneSample } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);

    const demo = samples.find((s) => s.demo);
    assert.ok(demo, 'a demo copy should be present by default');
    assert.equal(demo.id, 'f10_mouse_eye_demo');
    assert.notEqual(demo.offset.x, 0, 'the copy is offset so it does not overlap');
    assert.equal(demo.structures.length, samples[0].structures.length);
    assert.equal(demo.structures[0].sampleId, demo.id);
    assert.notEqual(demo.structures[0].color, samples[0].structures[0].color,
      'the copy is recoloured so the two are distinguishable when overlaid');
  });

  test('does not add a demo copy when the manifest already has several samples', async () => {
    setLocation('');
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: CSV } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);
    assert.equal(samples.length, 2);
    assert.ok(!samples.some((s) => s.demo));
  });

  test('?demo=off suppresses the demo copy', async () => {
    const oneSample = [HEADER, 'F10 mouse eye,,retina.glb,Retina,local/F10/retina.glb,'].join('\n');
    setLocation('?demo=off');
    globalThis.fetch = makeFetch({ [MANIFEST_URL]: { body: oneSample } });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);
    assert.equal(samples.length, 1);
  });
});

describe('fetchManifest retry', () => {
  test('recovers from the Hugging Face cold-start 405', async () => {
    let n = 0;
    const fetchStub = makeFetch({
      [MANIFEST_URL]: () => (++n < 3
        ? { status: 405, statusText: 'Method Not Allowed' }
        : { body: CSV }),
    });
    globalThis.fetch = fetchStub;
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);

    assert.equal(n, 3, 'should have retried twice before succeeding');
    assert.equal(samples.length, 2);
  });

  test('retries network errors too', async () => {
    let n = 0;
    globalThis.fetch = makeFetch({
      [MANIFEST_URL]: () => (++n < 2 ? new TypeError('Failed to fetch') : { body: CSV }),
    });
    const { loadCSVData } = await importFresh('data-loader.js');
    const { samples } = await loadCSVData(MANIFEST_URL);
    assert.equal(n, 2);
    assert.equal(samples.length, 2);
  });

  test('gives up after four attempts and reports the status', async () => {
    let n = 0;
    globalThis.fetch = makeFetch({
      [MANIFEST_URL]: () => { n++; return { status: 500, statusText: 'Server Error' }; },
    });
    const { loadCSVData } = await importFresh('data-loader.js');
    await assert.rejects(() => loadCSVData(MANIFEST_URL), /HTTP 500/);
    assert.equal(n, 4);
  });
});

describe('resolveStructure', () => {
  const stlPath = 'https://hf.test/resolve/main/sample_1_seg_mesh/eye.stl';

  test('swaps in the optimized GLB when one is published', async () => {
    globalThis.fetch = makeFetch({
      'optimized/sample_1_seg_mesh/eye.glb': { headers: { 'content-length': '622000' } },
    });
    const { resolveStructure } = await importFresh('data-loader.js');
    const st = { path: stlPath, kind: 'stl' };
    await resolveStructure(st);

    assert.equal(st.path, 'optimized/sample_1_seg_mesh/eye.glb');
    assert.equal(st.kind, 'gltf');
    assert.equal(st.optimized, true);
    assert.equal(st.bytes, 622000);
  });

  test('keeps the original when no optimized copy exists', async () => {
    globalThis.fetch = makeFetch({ [stlPath]: { headers: { 'content-length': '1073741824' } } });
    const { resolveStructure } = await importFresh('data-loader.js');
    const st = { path: stlPath, kind: 'stl' };
    await resolveStructure(st);

    assert.equal(st.path, stlPath, 'falls back to the Hugging Face original');
    assert.equal(st.kind, 'stl');
    assert.notEqual(st.optimized, true);
    assert.equal(st.bytes, 1073741824);
  });

  test('still resolves when the size probe fails', async () => {
    globalThis.fetch = makeFetch({ [stlPath]: new TypeError('network down') });
    const { resolveStructure } = await importFresh('data-loader.js');
    const st = { path: stlPath, kind: 'stl' };
    await resolveStructure(st);
    assert.equal(st._resolved, true);
  });

  test('is idempotent and probes the network only once', async () => {
    const fetchStub = makeFetch({
      'optimized/sample_1_seg_mesh/eye.glb': { headers: { 'content-length': '10' } },
    });
    globalThis.fetch = fetchStub;
    const { resolveStructure } = await importFresh('data-loader.js');
    const st = { path: stlPath, kind: 'stl' };

    await Promise.all([resolveStructure(st), resolveStructure(st)]);
    await resolveStructure(st);
    assert.equal(fetchStub.calls.length, 1);
  });

  test('uses HEAD so that probing never downloads the mesh', async () => {
    const fetchStub = makeFetch({
      'optimized/sample_1_seg_mesh/eye.glb': { headers: { 'content-length': '10' } },
    });
    globalThis.fetch = fetchStub;
    const { resolveStructure } = await importFresh('data-loader.js');
    await resolveStructure({ path: stlPath, kind: 'stl' });
    assert.equal(fetchStub.calls[0].init.method, 'HEAD');
  });
});

describe('probeSizes', () => {
  test('resolves every structure and reports each one', async () => {
    globalThis.fetch = makeFetch({
      [MANIFEST_URL]: { body: CSV },
      'local/': { headers: { 'content-length': '103424' } },
      'optimized/': { headers: { 'content-length': '622000' } },
    });
    const { loadCSVData, probeSizes } = await importFresh('data-loader.js');
    const data = await loadCSVData(MANIFEST_URL);

    const seen = [];
    await probeSizes((st) => seen.push(st));

    const total = data.samples.flatMap((s) => s.structures).length;
    assert.equal(seen.length, total);
    assert.ok(seen.every((s) => s._resolved));
  });

  test('one failing probe does not abort the others', async () => {
    globalThis.fetch = makeFetch({
      [MANIFEST_URL]: { body: CSV },
      'local/F10/retina.glb': new TypeError('boom'),
      'local/': { headers: { 'content-length': '1000' } },
      'optimized/': { headers: { 'content-length': '2000' } },
    });
    const { loadCSVData, probeSizes } = await importFresh('data-loader.js');
    const data = await loadCSVData(MANIFEST_URL);
    await probeSizes(() => {});
    assert.ok(data.samples.flatMap((s) => s.structures).every((s) => s._resolved));
  });
});
