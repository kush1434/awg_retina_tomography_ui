// ============================================================================
//  Tests for asset-loader.js — streaming download with progress, cancellation
//  and the Cache Storage layer that keeps heavy meshes from being re-fetched.
// ============================================================================

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setLocation, setSecureContext, setCaches, unsetCaches, FakeCacheStorage,
  makeFetch, chunkedBody, bytes, importFresh, withCleanGlobals,
} from './helpers/browser-env.js';

const URL_A = 'https://hf.test/resolve/main/retina.glb';

/** Install a secure browser-like context with a working Cache Storage. */
function secureEnv() {
  setLocation('', 'https:');
  setSecureContext(true);
  return setCaches(new FakeCacheStorage());
}

let restore;
beforeEach(() => { restore = withCleanGlobals(); });
afterEach(() => restore());

describe('fetchBuffer — downloading', () => {
  test('returns the complete buffer', async () => {
    secureEnv();
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(4, 7), bytes(6, 9)]) });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const buf = await fetchBuffer(URL_A);
    assert.equal(buf.byteLength, 10);
    const view = new Uint8Array(buf);
    assert.deepEqual([...view.slice(0, 4)], [7, 7, 7, 7]);
    assert.deepEqual([...view.slice(4)], [9, 9, 9, 9, 9, 9]);
  });

  test('reports monotonic progress against the declared total', async () => {
    secureEnv();
    globalThis.fetch = makeFetch({
      [URL_A]: chunkedBody([bytes(100), bytes(100), bytes(56)]),
    });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const seen = [];
    await fetchBuffer(URL_A, { onProgress: (p) => seen.push(p) });

    assert.deepEqual(seen.map((p) => p.loaded), [100, 200, 256]);
    assert.ok(seen.every((p) => p.total === 256), 'total stays the declared size');
    assert.ok(seen.every((p) => p.loaded <= p.total), 'progress never exceeds 100%');
  });

  test('still returns the data when content-length is absent', async () => {
    secureEnv();
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(8), bytes(8)], null) });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const seen = [];
    const buf = await fetchBuffer(URL_A, { onProgress: (p) => seen.push(p) });
    assert.equal(buf.byteLength, 16);
    assert.equal(seen.at(-1).total, 0, 'an unknown total is reported as 0');
  });

  test('trusts the bytes actually received when content-length lies', async () => {
    secureEnv();
    // Server claims 999 bytes but sends 12.
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(6, 3), bytes(6, 4)], 999) });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const buf = await fetchBuffer(URL_A);
    assert.equal(buf.byteLength, 12, 'buffer is sized to the real payload, not the claim');
    assert.deepEqual([...new Uint8Array(buf)], [3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4]);
  });

  test('falls back to a buffered read when the response has no stream', async () => {
    secureEnv();
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '5' }),
      body: null,
      arrayBuffer: async () => bytes(5, 2).buffer,
    });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const seen = [];
    const buf = await fetchBuffer(URL_A, { onProgress: (p) => seen.push(p) });
    assert.equal(buf.byteLength, 5);
    assert.deepEqual(seen, [{ loaded: 5, total: 5 }]);
  });

  test('throws a readable error on an HTTP failure', async () => {
    secureEnv();
    globalThis.fetch = makeFetch({ [URL_A]: { status: 404, statusText: 'Not Found' } });
    const { fetchBuffer } = await importFresh('asset-loader.js');
    await assert.rejects(() => fetchBuffer(URL_A), /HTTP 404 Not Found/);
  });

  test('propagates an abort so a layer download can be cancelled', async () => {
    secureEnv();
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(4)]) });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => fetchBuffer(URL_A, { signal: ac.signal }), { name: 'AbortError' });
  });

  test('a cancelled download leaves nothing in the cache', async () => {
    const storage = secureEnv();
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(4)]) });
    const { fetchBuffer, isCached } = await importFresh('asset-loader.js');

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => fetchBuffer(URL_A, { signal: ac.signal }));
    assert.equal(await isCached(URL_A), false);
    assert.equal(storage.stores.get('retina-assets-v2')?.size ?? 0, 0);
  });
});

describe('fetchBuffer — caching', () => {
  test('serves a second request from cache without touching the network', async () => {
    secureEnv();
    const fetchStub = makeFetch({ [URL_A]: chunkedBody([bytes(32, 5)]) });
    globalThis.fetch = fetchStub;
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const first = await fetchBuffer(URL_A);
    const second = await fetchBuffer(URL_A);

    assert.equal(fetchStub.calls.length, 1, 'the mesh is downloaded exactly once');
    assert.equal(second.byteLength, first.byteLength);
    assert.deepEqual([...new Uint8Array(second)], [...new Uint8Array(first)]);
  });

  test('flags a cache hit so the UI can label it', async () => {
    secureEnv();
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(16)]) });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    await fetchBuffer(URL_A);
    const seen = [];
    await fetchBuffer(URL_A, { onProgress: (p) => seen.push(p) });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].fromCache, true);
    assert.equal(seen[0].loaded, seen[0].total, 'a cache hit reports as complete');
  });

  test('caches a response that arrived without content-length', async () => {
    secureEnv();
    const fetchStub = makeFetch({ [URL_A]: chunkedBody([bytes(8), bytes(8)], null) });
    globalThis.fetch = fetchStub;
    const { fetchBuffer, isCached } = await importFresh('asset-loader.js');

    await fetchBuffer(URL_A);
    assert.equal(await isCached(URL_A), true);
    await fetchBuffer(URL_A);
    assert.equal(fetchStub.calls.length, 1);
  });

  test('isCached reflects what has been downloaded', async () => {
    secureEnv();
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(8)]) });
    const { fetchBuffer, isCached } = await importFresh('asset-loader.js');

    assert.equal(await isCached(URL_A), false);
    await fetchBuffer(URL_A);
    assert.equal(await isCached(URL_A), true);
  });

  test('clearCache empties the store and forces a re-download', async () => {
    secureEnv();
    const fetchStub = makeFetch({ [URL_A]: chunkedBody([bytes(8)]) });
    globalThis.fetch = fetchStub;
    const { fetchBuffer, isCached, clearCache } = await importFresh('asset-loader.js');

    await fetchBuffer(URL_A);
    await clearCache();
    assert.equal(await isCached(URL_A), false);
    await fetchBuffer(URL_A);
    assert.equal(fetchStub.calls.length, 2);
  });

  test('survives a cache write that fails on quota', async () => {
    setLocation('', 'https:');
    setSecureContext(true);
    setCaches({
      async open() {
        return {
          async match() { return undefined; },
          async put() { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
        };
      },
      async delete() { return true; },
    });
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(64)]) });
    const { fetchBuffer } = await importFresh('asset-loader.js');

    const buf = await fetchBuffer(URL_A);
    assert.equal(buf.byteLength, 64, 'the download still succeeds; caching is best-effort');
  });

  test('survives caches.open() itself throwing', async () => {
    setLocation('', 'https:');
    setSecureContext(true);
    setCaches({ async open() { throw new Error('storage disabled'); }, async delete() {} });
    globalThis.fetch = makeFetch({ [URL_A]: chunkedBody([bytes(4)]) });
    const { fetchBuffer, isCached } = await importFresh('asset-loader.js');

    assert.equal((await fetchBuffer(URL_A)).byteLength, 4);
    assert.equal(await isCached(URL_A), false);
  });
});

describe('fetchBuffer — insecure context', () => {
  test('downloads normally when Cache Storage is unavailable', async () => {
    setLocation('', 'http:');
    setSecureContext(false);
    unsetCaches();
    const fetchStub = makeFetch({ [URL_A]: chunkedBody([bytes(20)]) });
    globalThis.fetch = fetchStub;
    const { fetchBuffer, isCached, clearCache } = await importFresh('asset-loader.js');

    assert.equal((await fetchBuffer(URL_A)).byteLength, 20);
    assert.equal((await fetchBuffer(URL_A)).byteLength, 20);
    assert.equal(fetchStub.calls.length, 2, 'nothing is cached, so both hit the network');
    assert.equal(await isCached(URL_A), false);
    await assert.doesNotReject(() => clearCache());
  });
});
