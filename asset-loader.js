// ============================================================================
//  asset-loader.js — streaming downloads with progress, cancellation, and a
//  persistent on-disk cache (Cache Storage API) so heavy meshes download once.
// ============================================================================

const CACHE_NAME = 'retina-assets-v1';

// Cache Storage is only available in secure contexts (https / localhost).
const cacheSupported =
  typeof caches !== 'undefined' && (self.isSecureContext ?? location.protocol === 'https:');

async function openCache() {
  if (!cacheSupported) return null;
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}

/**
 * Download a URL as an ArrayBuffer with progress reporting, cancellation and
 * transparent caching. If a cached copy exists it is returned instantly.
 *
 * @param {string} url
 * @param {object}   [opts]
 * @param {(p: {loaded: number, total: number, fromCache?: boolean}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchBuffer(url, { onProgress, signal } = {}) {
  const cache = await openCache();

  // 1) Serve from cache when possible.
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, fromCache: true });
      return buf;
    }
  }

  // 2) Stream the network response so we can report progress.
  const res = await fetch(url, { mode: 'cors', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length')) || 0;

  // No stream support (or no body) → fall back to a plain buffered read.
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    onProgress?.({ loaded: buf.byteLength, total: total || buf.byteLength });
    await putInCache(cache, url, buf);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total });
  }

  // Concatenate chunks into one contiguous buffer.
  const out = new Uint8Array(total || loaded);
  if (total && total === loaded) {
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  } else {
    const merged = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    await putInCache(cache, url, merged.buffer);
    return merged.buffer;
  }

  await putInCache(cache, url, out.buffer);
  return out.buffer;
}

async function putInCache(cache, url, buffer) {
  if (!cache) return;
  try {
    await cache.put(url, new Response(buffer));
  } catch {
    // Quota exceeded (very large files) — caching is best-effort, ignore.
  }
}

/** Whether a URL is already cached (used to label "cached" in the UI). */
export async function isCached(url) {
  const cache = await openCache();
  if (!cache) return false;
  return !!(await cache.match(url));
}

/** Clear the entire asset cache. */
export async function clearCache() {
  if (!cacheSupported) return;
  try { await caches.delete(CACHE_NAME); } catch { /* ignore */ }
}
