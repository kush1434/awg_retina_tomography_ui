// ============================================================================
//  anatomy-models.js — the registry of reference eye models the left pane can
//  show: per-structure styling, the model list (available and surveyed-but-
//  unavailable alike) and the pure lookups the app and the anatomy controller
//  use to resolve a model, a structure or a preset. Plain data, no DOM.
// ============================================================================

// The left pane can show any of several published open-source eye models. Each
// ships as one Draco glTF with a named node per anatomical structure — see
// optimized/anatomy/README.md for provenance and licences.
//
// Per structure: `key` matches the glTF node name. `coat` marks the structures
// the µCT segmentation on the right also resolves, so the two panes can be read
// against each other. `depth` is how deeply nested the structure sits
// (0 = outermost); translucent shells are drawn back-faces outermost-in, then
// front-faces innermost-out, which is what makes them blend in the right order.
//
// Models flagged `unavailable` are the remaining projects surveyed for this
// pane. They are listed rather than hidden so it is clear they were considered
// and why they cannot be rendered — they are simulation code or data-driven
// models that ship no 3D anatomical geometry at all.

// The cornea and aqueous are all but colourless in life; tinting them any
// harder than this fogs the iris behind them to grey.
const S = {
  sclera:      { label: 'Sclera',                 group: 'Ocular coats',      color: 0xc6c0b2, opacity: 1.00, rough: 0.52, depth: 0, coat: true },
  choroid:     { label: 'Choroid',                group: 'Ocular coats',      color: 0x8e2b3c, opacity: 1.00, rough: 0.58, depth: 1, coat: true },
  retina:      { label: 'Retina',                 group: 'Ocular coats',      color: 0xd9634c, opacity: 1.00, rough: 0.62, depth: 2, coat: true },
  cornea:      { label: 'Cornea',                 group: 'Anterior segment',  color: 0xd6edf5, opacity: 0.15, rough: 0.05, depth: 0 },
  aqueous:     { label: 'Aqueous humour',         group: 'Anterior segment',  color: 0xd8f0f8, opacity: 0.05, rough: 0.05, depth: 1 },
  iris:        { label: 'Iris',                   group: 'Anterior segment',  color: 0x8a5626, opacity: 1.00, rough: 0.70, depth: 2 },
  zonules:     { label: 'Suspensory ligament',    group: 'Anterior segment',  color: 0xe6dfc9, opacity: 0.85, rough: 0.35, depth: 3 },
  lens:        { label: 'Lens',                   group: 'Anterior segment',  color: 0xefdaa6, opacity: 0.82, rough: 0.10, depth: 3 },
  vitreous:    { label: 'Vitreous humour',        group: 'Posterior segment', color: 0xbfe2f0, opacity: 0.09, rough: 0.08, depth: 3 },
  lamina:      { label: 'Lamina cribrosa',        group: 'Optic nerve head',  color: 0x8fbe9a, opacity: 1.00, rough: 0.62, depth: 3 },
  optic_nerve: { label: 'Optic nerve',            group: 'Optic nerve head',  color: 0xded3b8, opacity: 1.00, rough: 0.66, depth: 1 },
  artery:      { label: 'Central retinal artery', group: 'Retinal vessels',   color: 0xc62f2f, opacity: 1.00, rough: 0.55, depth: 2 },
  vein:        { label: 'Retinal vein',           group: 'Retinal vessels',   color: 0x4a5aa8, opacity: 1.00, rough: 0.55, depth: 2 },
  globe:       { label: 'Globe (sclera)',         group: 'Globe',             color: 0xc6c0b2, opacity: 1.00, rough: 0.52, depth: 0, coat: true },
  pupil:       { label: 'Cornea / pupil',         group: 'Globe',             color: 0x2b2f36, opacity: 1.00, rough: 0.30, depth: 1 },
};
// Anything not in S is an extraocular muscle, given as [key, label].
const muscle = (label) => ({ label, group: 'Extraocular muscles', color: 0xb84540, opacity: 1.00, rough: 0.66, depth: 0 });
const struct = (keys) => keys.map((k) => (Array.isArray(k)
  ? { key: k[0], ...muscle(k[1]) }
  : { key: k, ...S[k] }));

const ANATOMY_MODELS = [
  {
    id: 'mesheye',
    label: 'mesh.eye',
    blurb: 'Human eyeball · 10 structures incl. lamina cribrosa',
    url: 'optimized/anatomy/eye-anatomy.glb',
    source: 'feelpp/mesh.eye', href: 'https://github.com/feelpp/mesh.eye', license: 'GPL-3.0', focus: 'sclera',
    structures: struct(['sclera', 'choroid', 'retina', 'cornea', 'aqueous', 'iris', 'lens', 'vitreous', 'lamina', 'optic_nerve']),
    presets: {
      whole: { label: 'Whole eye', desc: 'Intact globe · clear cornea', hidden: [], opacity: {} },
      coats: { label: 'Coats', desc: 'The three coats the µCT segments',
        hidden: ['cornea', 'aqueous', 'iris', 'lens', 'vitreous'],
        opacity: { sclera: 0.26, choroid: 0.62, retina: 1 } },
      media: { label: 'Media', desc: 'The optical path, coats faded back', hidden: [],
        opacity: { sclera: 0.10, choroid: 0.12, retina: 0.16, cornea: 0.45, aqueous: 0.26, vitreous: 0.2, lens: 0.95, iris: 1, optic_nerve: 0.5 } },
    },
  },
  {
    id: 'humaneye',
    label: 'Feel++ CAD eye',
    blurb: 'The CAD eye mesh.eye derives from · adds zonules & vessels',
    url: 'optimized/anatomy/human-eye-cad.glb',
    source: 'feelpp/mesh.eye', href: 'https://github.com/feelpp/mesh.eye', license: 'GPL-3.0', focus: 'sclera',
    structures: struct(['sclera', 'choroid', 'retina', 'cornea', 'iris', 'zonules', 'lens', 'vitreous', 'artery', 'vein']),
    presets: {
      whole: { label: 'Whole eye', desc: 'Intact globe · clear cornea', hidden: [], opacity: {} },
      coats: { label: 'Coats', desc: 'The three coats the µCT segments',
        hidden: ['cornea', 'iris', 'zonules', 'lens', 'vitreous'],
        opacity: { sclera: 0.26, choroid: 0.62, retina: 1, artery: 1, vein: 1 } },
      media: { label: 'Media', desc: 'The optical path, coats faded back', hidden: [],
        opacity: { sclera: 0.10, choroid: 0.12, retina: 0.16, cornea: 0.45, vitreous: 0.2, lens: 0.95, iris: 1, zonules: 1 } },
    },
  },
  {
    id: 'upat',
    label: 'Upatras oculomotor',
    blurb: 'Globe + the six extraocular muscles',
    url: 'optimized/anatomy/upat-oculomotor.glb',
    source: 'Upatras eye model', href: 'https://simtk.org/projects/eye', license: 'CC BY 4.0', focus: 'globe',
    structures: struct(['globe', 'pupil',
      ['lateral_rectus', 'Lateral rectus'], ['medial_rectus', 'Medial rectus'],
      ['superior_rectus', 'Superior rectus'], ['inferior_rectus', 'Inferior rectus'],
      ['superior_oblique', 'Superior oblique'], ['inferior_oblique', 'Inferior oblique']]),
    presets: {
      whole: { label: 'Whole', desc: 'Globe with all six muscles', hidden: [], opacity: {} },
      muscles: { label: 'Muscles', desc: 'Muscles over a translucent globe', hidden: [],
        opacity: { globe: 0.22, pupil: 0.5 } },
      recti: { label: 'Recti', desc: 'The four recti only', hidden: ['superior_oblique', 'inferior_oblique'],
        opacity: { globe: 0.3, pupil: 0.6 } },
    },
  },
  // Surveyed, but none ships 3D eye geometry. Reasons are the checked facts,
  // not guesses — see optimized/anatomy/README.md for how each was verified.
  { id: 'isetbio',    label: 'ISETBio',          unavailable: 'MATLAB optics + cone mosaic. Zero mesh files in the repo' },
  { id: 'openretina', label: 'OpenRetina',       unavailable: 'Networks predicting retinal spike responses. Nothing spatial' },
  { id: 'vcornea',    label: 'V-Cornea',         unavailable: 'Corneal epithelium on a 200×90 lattice — 2D, z=0 for all 12,085 cells' },
  { id: 'openeyesim', label: 'OpenEyeSim',       unavailable: 'No public download; the authors distribute it by email' },
  { id: 'p2p',        label: 'pulse2percept',    unavailable: 'Implant electrode arrays (250 µm discs), not eye anatomy' },
  { id: 'osb',        label: 'Open Source Brain', unavailable: 'NeuroML single-neuron morphologies, not ocular anatomy' },
];

const DEFAULT_MODEL_ID = 'mesheye';
const modelById = (id) => ANATOMY_MODELS.find((m) => m.id === id && !m.unavailable);

// The `?model=` rule: an id that names an available model is honoured; anything
// else (unknown, unavailable or missing) falls back to the default model.
const resolveModelId = (id) => (modelById(id) ? id : DEFAULT_MODEL_ID);

// Structure metadata for `key` within `model`, or undefined when the model has
// no structure by that name.
const structureMeta = (model, key) => model.structures.find((s) => s.key === key);

// A named preset of `model`, or undefined when it has none by that name.
const presetOf = (model, name) => model.presets?.[name];

export {
  S as STRUCTURE_STYLES, muscle, struct, ANATOMY_MODELS, DEFAULT_MODEL_ID, modelById,
  resolveModelId, structureMeta, presetOf,
};
