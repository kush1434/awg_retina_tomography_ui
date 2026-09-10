// ============================================================================
//  browser-env.js — minimal browser globals so the viewer's data modules can be
//  exercised under `node --test`. Both modules read `location` (for URL
//  parameters) and asset-loader.js probes `caches` / `isSecureContext` at
//  import time, so these must be installed *before* a dynamic import().
// ============================================================================

/**
 * Install a stub `location` with the given query string.
 * @param {string} [search] e.g. '?dataset=x&demo=off'
 */
export function setLocation(search = '', protocol = 'https:') {
  globalThis.location = {
    search,
    protocol,
    href: `${protocol}//example.test/${search}`,
  };
}

/** Install a `self` with the given secure-context flag. */
export function setSecureContext(isSecure = true) {
  globalThis.self = { isSecureContext: isSecure };
}

/**
 * A tiny in-memory stand-in for the Cache Storage API — enough for
 * asset-loader.js (open / match / put / delete).
 */
export class FakeCacheStorage {
  constructor() { this.stores = new Map(); }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const store = this.stores.get(name);
    return {
      async match(url) {
        const buf = store.get(url);
        return buf ? new Response(buf) : undefined;
      },
      async put(url, response) {
        store.set(url, await response.arrayBuffer());
      },
      _store: store,
    };
  }
  async delete(name) { return this.stores.delete(name); }
}

/** Install a fake `caches` global and return it. */
export function setCaches(storage = new FakeCacheStorage()) {
  globalThis.caches = storage;
  return storage;
}

/** Remove the Cache Storage API entirely (simulates an insecure context). */
export function unsetCaches() { delete globalThis.caches; }

/**
 * Build a `fetch` stub from a routing table.
 *
 * @param {Record<string, object|Function>} routes keyed by exact URL or by a
 *   substring; the value is a descriptor `{status, body, headers}` or a
 *   function `(url, init) => descriptor`.
 * @returns {Function & {calls: Array}} the stub, with a `calls` log attached.
 */
export function makeFetch(routes) {
  const calls = [];
  const fetchStub = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.signal?.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    let match = routes[url];
    if (!match) {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      if (key) match = routes[key];
    }
    if (!match) return new Response(null, { status: 404, statusText: 'Not Found' });

    const desc = typeof match === 'function' ? await match(String(url), init) : match;
    if (desc instanceof Error) throw desc;

    const { status = 200, body = '', headers = {}, statusText = '' } = desc;
    const hdrs = new Headers(headers);
    if (body && !hdrs.has('content-length')) {
      const len = typeof body === 'string'
        ? new TextEncoder().encode(body).byteLength
        : body.byteLength;                      // undefined for a ReadableStream
      if (Number.isFinite(len)) hdrs.set('content-length', String(len));
    }
    // HEAD responses must not carry a body.
    const payload = init.method === 'HEAD' || status === 204 ? null : body;
    return new Response(payload, { status, statusText, headers: hdrs });
  };
  fetchStub.calls = calls;
  return fetchStub;
}

/**
 * Import a module fresh, bypassing the ES module cache, so that its top-level
 * side effects re-run against the currently installed globals.
 * @param {string} specifier relative to the repository root.
 */
let bust = 0;
export function importFresh(specifier) {
  const url = new URL(`../../${specifier}`, import.meta.url);
  url.searchParams.set('t', String(bust++));
  return import(url.href);
}

/** Snapshot the globals these tests touch, returning a restore function. */
export function withCleanGlobals() {
  const saved = {
    fetch: globalThis.fetch,
    location: globalThis.location,
    caches: globalThis.caches,
    self: globalThis.self,
  };
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  };
}

/**
 * A route descriptor whose body arrives as several discrete chunks, so that
 * streaming progress reporting can be observed. Returns a factory, so each
 * request gets an unread stream.
 * @param {Uint8Array[]} chunks
 * @param {number|null} [declaredTotal] value for content-length; pass null to
 *   omit the header, or a wrong number to simulate a mismatched length.
 */
export function chunkedBody(chunks, declaredTotal) {
  const total = declaredTotal === undefined
    ? chunks.reduce((n, c) => n + c.byteLength, 0)
    : declaredTotal;
  // A stream can only be consumed once, so hand out a fresh one per request —
  // otherwise a re-download test would read an already-drained body.
  return () => ({
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c.slice());
        controller.close();
      },
    }),
    headers: total === null ? {} : { 'content-length': String(total) },
  });
}

/** Build a Uint8Array of `n` bytes filled with `fill`. */
export function bytes(n, fill = 1) { return new Uint8Array(n).fill(fill); }
