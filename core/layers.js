// ============================================================================
//  layers.js — the segmented layers on the stl pane. One LayerController owns
//  the sample groups (one normalised THREE.Group per sample, stacked under
//  `pane.root`), the loaded layer objects, the in-flight downloads and the
//  per-layer / per-sample colour, opacity and offset rules; load() downloads a
//  layer through the injected `io`, parses it with the injected `parsers` and
//  frames the workspace. Three-only: every UI-visible transition leaves through
//  `emitter` (layer:state, layer:progress, layer:error, layers:visible,
//  sample:offset) and the app renders it — the controller never sees a row.
//  The sample / structure records are the data-loader's own objects; this is
//  the only module that writes `sample.offset/opacity` and
//  `structure.color/opacity`.
// ============================================================================

import * as THREE from 'three';
import { normalizeGroup, fitBox, unionBoxOfGroups } from './framing.js';
import { applyColor, setObjectOpacity, disposeObject } from './materials.js';
import { clearCaps, updateBounds, applyRenderModeToPane, buildCaps } from './clipping.js';

// A layer above this size asks before its first download (the app owns the
// confirm; `isHeavy` is the rule).
export const HEAVY_BYTES = 400 * 1024 * 1024;

// "Solid fill" mode: swap the F10 ocular coats for their solid-slab variant,
// which fills each coat inward to the next coat (no gaps, no hollow shells).
// The variant meshes ship alongside the normal ones under optimized/<dir>_solid/.
export function solidVariant(path) {
  // Map any F10 coat path (remote HF original or local optimized) to the
  // locally-shipped solid-fill slab, so the toggle works regardless of source.
  const m = path && path.match(/F10_layers\/([^/?#]+\.glb)/i);
  return m ? `optimized/F10_layers_solid/${m[1]}` : null;
}
export function effectivePath(structure, view) {
  if (view.solidFill) { const v = solidVariant(structure.path); if (v) return v; }
  return structure.path;
}

/**
 * Segmented-layer controller for one pane (the stl workspace).
 *
 * @param {object} ctx
 * @param {object} ctx.pane the stl pane from createPane (capsEnabled)
 * @param {object} ctx.view the live view state ({ renderMode, layout, globalOpacity, linkOffsets, solidFill, clipState })
 * @param {{ fetchBuffer: Function, isCached: Function }} ctx.io
 * @param {{ parseSTL: Function, parseGLTF: Function }} ctx.parsers
 * @param {{ emit: Function }} ctx.emitter
 */
export class LayerController {
  constructor({ pane, view, io, parsers, emitter }) {
    this.pane = pane;
    this.view = view;
    this.io = io;
    this.parsers = parsers;
    this.emitter = emitter;

    // The pane is the "overlay workspace": every sample is a normalised group
    // under pane.root, so samples stack on top of each other.
    this.sampleGroups = new Map();     // sampleId -> THREE.Group
    this.featureObjects = new Map();   // structureId -> THREE.Object3D
    this.inFlight = new Map();         // structureId -> AbortController
    this.stlFitted = false;
    // The data-loader's records; empty until the manifest arrives so every
    // method is safe to call before then.
    this.samples = [];
  }

  // -------------------------------------------------------------------------
  //  Samples and structures
  // -------------------------------------------------------------------------
  setSamples(samples) { this.samples = samples; }

  findStructure(id) {
    for (const s of this.samples) { const f = s.structures.find((x) => x.id === id); if (f) return f; }
    return null;
  }
  findSample(id) { return this.samples.find((s) => s.id === id) || null; }
  has(id) { return this.featureObjects.has(id); }
  groupCount() { return this.sampleGroups.size; }

  getSampleGroup(sampleId) {
    let g = this.sampleGroups.get(sampleId);
    if (!g) { g = new THREE.Group(); g.userData.sampleId = sampleId; this.pane.root.add(g); this.sampleGroups.set(sampleId, g); }
    return g;
  }

  normalizeSample(sampleId) {
    const g = this.sampleGroups.get(sampleId);
    const sample = this.findSample(sampleId);
    if (g && sample) normalizeGroup(g, sample.offset);
  }

  // -------------------------------------------------------------------------
  //  Offsets (stack / separate)
  // -------------------------------------------------------------------------
  // Set one sample's offset on an axis, reporting it (the app syncs the
  // slider) and re-normalising the 3D group.
  setSampleOffset(sample, ax, value) {
    sample.offset[ax] = value;
    this.emitter.emit('sample:offset', { sampleId: sample.id, axis: ax, value });
    this.normalizeSample(sample.id);
  }

  // Apply an offset to the edited sample, or — when linked — to every sample.
  offsetChanged(sample, ax, value) {
    if (this.view.linkOffsets) this.samples.forEach((s) => this.setSampleOffset(s, ax, value));
    else this.setSampleOffset(sample, ax, value);
    updateBounds(this.pane, this.view);
  }

  resetOffsets(sample) {
    const targets = this.view.linkOffsets ? this.samples : [sample];
    for (const s of targets) for (const ax of ['x', 'y', 'z']) this.setSampleOffset(s, ax, 0);
    updateBounds(this.pane, this.view);
  }

  // Snap every sample to the first sample's offset (linking offsets).
  snapOffsetsToFirst() {
    const base = this.samples[0]?.offset || { x: 0, y: 0, z: 0 };
    for (const ax of ['x', 'y', 'z']) this.samples.forEach((s) => this.setSampleOffset(s, ax, base[ax]));
    updateBounds(this.pane, this.view);
  }

  // -------------------------------------------------------------------------
  //  Colour, opacity, visibility
  // -------------------------------------------------------------------------
  // Effective opacity = per-layer × per-sample × global.
  reapplyOpacity(structure) {
    const obj = this.featureObjects.get(structure.id);
    if (!obj) return;
    const sample = this.findSample(structure.sampleId);
    setObjectOpacity(obj, structure.opacity * (sample?.opacity ?? 1) * this.view.globalOpacity);
  }
  reapplyAllOpacity() {
    for (const id of this.featureObjects.keys()) { const st = this.findStructure(id); if (st) this.reapplyOpacity(st); }
  }

  setColor(structure, hex) {
    structure.color = hex;
    const obj = this.featureObjects.get(structure.id);
    if (obj) applyColor(obj, structure.color);
    buildCaps(this.pane, this.view);
  }
  setOpacity(structure, v) {
    structure.opacity = v;
    this.reapplyOpacity(structure);
  }
  setSampleOpacity(sample, v) {
    sample.opacity = v;
    sample.structures.forEach((st) => this.reapplyOpacity(st));
  }
  // Whole-sample toggle: flips the group only (no visibility sync).
  setSampleVisible(sampleId, on) {
    const g = this.sampleGroups.get(sampleId);
    if (g) g.visible = on;
  }

  // Show / hide one layer. Syncs even when the id has no object yet (the row
  // may be unchecked mid-download) so the empty state and caps stay right.
  setVisible(id, on) {
    const o = this.featureObjects.get(id);
    if (o) o.visible = on;
    this.syncVisibility();
  }

  anyVisible() { return [...this.featureObjects.values()].some((o) => o.visible); }
  visibleIds() { return [...this.featureObjects].filter(([, o]) => o.visible).map(([id]) => id); }

  // Keep cross-section caps in sync with which coats are shown, then report.
  syncVisibility() {
    const anyVisible = this.anyVisible();
    buildCaps(this.pane, this.view);
    this.emitter.emit('layers:visible', { anyVisible, visibleIds: this.visibleIds() });
  }

  // -------------------------------------------------------------------------
  //  Framing
  // -------------------------------------------------------------------------
  // The workspace is framed on its sample groups (the subject); the anatomy,
  // which has far-reaching muscles/optic nerve, is context and may spill past.
  workspaceBox() { return unionBoxOfGroups(this.sampleGroups.values(), this.pane.root); }

  fitStl(offset = 1.45) {
    const box = this.workspaceBox();
    if (box.isEmpty()) return;
    fitBox(this.pane, box, offset);
    updateBounds(this.pane, this.view);
  }

  focusSample(sampleId) {
    const g = this.sampleGroups.get(sampleId);
    if (g && g.children.length) {
      const box = new THREE.Box3().setFromObject(g);
      if (!box.isEmpty()) { fitBox(this.pane, box, 1.6); updateBounds(this.pane, this.view); }
    }
  }

  // -------------------------------------------------------------------------
  //  Loading
  // -------------------------------------------------------------------------
  isHeavy(structure) { return Boolean(structure.bytes && structure.bytes > HEAVY_BYTES); }
  effectivePath(structure) { return effectivePath(structure, this.view); }

  // Reload every currently-loaded F10 coat from the active variant, preserving
  // each row's visibility. Called when the Solid-fill toggle flips.
  async reloadFillVariants() {
    const affected = [...this.featureObjects.keys()]
      .map((id) => this.findStructure(id))
      .filter((st) => st && solidVariant(st.path));
    clearCaps(this.pane);   // drop caps that reference geometry we're about to dispose
    for (const st of affected) {
      const obj = this.featureObjects.get(st.id);
      const wasVisible = !!obj && obj.visible;
      if (this.inFlight.has(st.id)) this.inFlight.get(st.id).abort();
      if (obj) { obj.parent?.remove(obj); disposeObject(obj); this.featureObjects.delete(st.id); }
      await this.load(st);
      const fresh = this.featureObjects.get(st.id);
      if (fresh) fresh.visible = wasVisible;
    }
    this.syncVisibility();
  }

  // Download, parse and place one layer. Never rejects: a failure is reported
  // as layer:state error + layer:error, an abort as layer:state idle (the only
  // place idle is emitted — abort() itself says nothing).
  async load(structure) {
    const { id } = structure;
    const url = this.effectivePath(structure);
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    this.emitter.emit('layer:state', { id, state: 'loading', phase: 'start' });

    try {
      const buffer = await this.io.fetchBuffer(url, {
        signal: controller.signal,
        onProgress: ({ loaded, total, fromCache }) => {
          if (fromCache) { this.emitter.emit('layer:state', { id, state: 'loading', phase: 'cache' }); return; }
          const pct = total ? Math.round((loaded / total) * 100) : 0;
          this.emitter.emit('layer:progress', { id, loaded, total, pct });
        },
      });
      this.emitter.emit('layer:state', { id, state: 'loading', phase: 'build' });

      const object = structure.kind === 'gltf' ? await this.parsers.parseGLTF(buffer) : this.parsers.parseSTL(buffer, structure);
      object.userData.id = id;
      this.featureObjects.set(id, object);
      const isNewGroup = !this.sampleGroups.has(structure.sampleId);
      this.getSampleGroup(structure.sampleId).add(object);
      applyColor(object, structure.color);
      this.normalizeSample(structure.sampleId);
      this.reapplyOpacity(structure);

      updateBounds(this.pane, this.view);
      if (!this.stlFitted || isNewGroup) { this.fitStl(this.view.layout === 'overlay' ? 1.7 : 1.45); this.stlFitted = true; }
      applyRenderModeToPane(this.pane, this.view);
      this.syncVisibility();
      const cached = await this.io.isCached(url);
      this.emitter.emit('layer:state', { id, state: 'loaded', cached });
    } catch (err) {
      if (err.name === 'AbortError') this.emitter.emit('layer:state', { id, state: 'idle' });
      else {
        console.error(`Layer "${structure.label}" failed:`, err);
        this.emitter.emit('layer:state', { id, state: 'error' });
        this.emitter.emit('layer:error', { id, label: structure.label, error: err });
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  // Cancel one download; the row returns to idle through load()'s catch.
  abort(id) { this.inFlight.get(id)?.abort(); }
  abortAll() { for (const c of this.inFlight.values()) c.abort(); }
}
