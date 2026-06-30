// ============================================================================
//  data-loader.js — loads & parses the dataset manifest (CSV) from Hugging Face
//  and exposes a clean, typed data model for the viewer to consume.
// ============================================================================

// Location of the dataset manifest. Can be overridden via ?dataset=<url>.
const DEFAULT_CSV_URL =
  'https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui/resolve/main/retina_tomography_ui%20dataset.csv';

/** Shared, reactive data structure consumed by the viewer. */
export const samplesData = { samples: [] };

// A curated, perceptually-spaced palette for auto-assigning structure colors.
const COLOR_PALETTE = [
  0x4dd0e1, 0x7e9cff, 0xff8a65, 0xba68c8,
  0xffd54f, 0x4db6ac, 0xef5350, 0x64b5f6,
  0x81c784, 0xffb74d, 0x90a4ae, 0xf06292,
];
let colorIndex = 0;
function nextColor() {
  return COLOR_PALETTE[colorIndex++ % COLOR_PALETTE.length];
}

/**
 * Parse a single CSV line, honouring double-quoted fields that may contain
 * commas. Good enough for this manifest (no embedded newlines expected).
 * @param {string} line
 * @returns {string[]}
 */
function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Infer the renderable type from a file URL. */
export function fileKind(url = '') {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.glb') || clean.endsWith('.gltf')) return 'gltf';
  if (clean.endsWith('.stl')) return 'stl';
  return 'stl';
}

/**
 * Load and parse the dataset manifest.
 * @param {string} [csvUrl]
 * @returns {Promise<typeof samplesData>}
 */
export async function loadCSVData(csvUrl) {
  const url = csvUrl || new URLSearchParams(location.search).get('dataset') || DEFAULT_CSV_URL;

  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Could not load dataset manifest (HTTP ${res.status}).`);
  const text = await res.text();

  const lines = text.replace(/\r/g, '').trim().split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw new Error('Dataset manifest is empty.');

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
  const col = (name) => headers.indexOf(name);
  const iSample = col('sample_name');
  const iSampleLink = col('sample_link');
  const iFile = col('file_name');
  const iLabel = col('seg_mesh_label');
  const iLink = col('seg_mesh_link');
  const iNotes = col('notes');

  const byName = new Map();
  colorIndex = 0;

  for (let i = 1; i < lines.length; i++) {
    const v = parseCSVLine(lines[i]);
    const sampleName = v[iSample];
    const fileName = v[iFile];
    const link = v[iLink];
    if (!sampleName || !fileName || !link) continue; // skip malformed rows

    if (!byName.has(sampleName)) {
      byName.set(sampleName, {
        id: sampleName.toLowerCase().replace(/\s+/g, '_'),
        label: sampleName,
        link: iSampleLink >= 0 ? v[iSampleLink] : '',
        structures: [],
      });
    }
    const sample = byName.get(sampleName);
    sample.structures.push({
      id: `${sample.id}__${fileName}`,
      label: (iLabel >= 0 && v[iLabel]) ? v[iLabel] : fileName,
      path: link,
      kind: fileKind(link),
      notes: iNotes >= 0 ? v[iNotes] : '',
      color: nextColor(),
      // The whole "eye" shell reads best semi-transparent so inner features show.
      opacity: /(^|_)eye($|\b)/i.test(fileName) ? 0.25 : 1.0,
      bytes: null,        // filled in asynchronously by probeSizes()
    });
  }

  samplesData.samples = [...byName.values()];
  return samplesData;
}

/**
 * Derive the path of an optimized (decimated + Draco) copy of an STL asset.
 * Optimized GLBs ship with the app under `optimized/<relative-path>.glb`
 * (same-origin → fast, no CORS), mirroring the dataset's folder layout.
 * Returns null when the source is not an STL we know how to optimize.
 */
export function deriveOptimizedURL(url = '') {
  if (!/\.stl(\?|$)/i.test(url)) return null;
  // Take the path after Hugging Face's `/resolve/<rev>/`, or the bare path.
  const m = url.match(/\/resolve\/[^/]+\/(.+)$/);
  const rel = (m ? m[1] : url.replace(/^https?:\/\/[^/]+\//, '')).split('?')[0];
  return `optimized/${rel.replace(/\.stl$/i, '.glb')}`;
}

async function headSize(url) {
  const res = await fetch(url, { method: 'HEAD', mode: 'cors' });
  if (!res.ok) return null;
  const len = Number(res.headers.get('content-length'));
  return Number.isFinite(len) && len > 0 ? len : 0;
}

/**
 * Resolve a single structure: prefer an optimized GLB if one has been
 * published, otherwise keep the original — and learn its byte size. Idempotent
 * (safe to call repeatedly); the result is memoised on the structure.
 * @returns {Promise<object>} the (mutated) structure.
 */
export async function resolveStructure(st) {
  if (st._resolved) return st;
  st._resolving ??= (async () => {
    const optURL = deriveOptimizedURL(st.path);
    if (optURL) {
      try {
        const optLen = await headSize(optURL);
        if (optLen !== null) {
          st.path = optURL; st.kind = 'gltf'; st.optimized = true;
          if (optLen) st.bytes = optLen;
          st._resolved = true;
          return st;
        }
      } catch { /* optimized copy not published — fall back */ }
    }
    try { const len = await headSize(st.path); if (len) st.bytes = len; }
    catch { /* size is a nice-to-have */ }
    st._resolved = true;
    return st;
  })();
  return st._resolving;
}

/**
 * Resolve every structure (optimized-vs-original + size) so the UI can show how
 * heavy a layer is before it is downloaded. All best-effort.
 * @param {(structure: object) => void} onResolved called as each one resolves.
 */
export async function probeSizes(onResolved) {
  const all = samplesData.samples.flatMap((s) => s.structures);
  await Promise.allSettled(all.map((st) => resolveStructure(st).then(onResolved)));
}

/** Human-readable byte size, e.g. 1.06 GB. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(val >= 10 ? 1 : 2)} ${units[i]}`;
}
