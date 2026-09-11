// ============================================================================
//  anatomy.js — the reference eye on the glb pane. One AnatomyController owns
//  which registry model is active, the loaded scene, the per-structure meshes
//  it recognised and their visibility / colour / opacity, the active preset,
//  the pane-level opacity and the overlay offset; load() downloads the model
//  through the injected `io`, parses it with the injected `parsers` and places
//  it in the glb pane (split) or, wrapped in its own normalised group, in the
//  stl workspace (overlay). Three-only: every UI-visible transition leaves
//  through `emitter` (anatomy:model, anatomy:status, anatomy:parts,
//  anatomy:preset, anatomy:style, anatomy:opacity, anatomy:visible,
//  anatomy:offset) and the app renders it — the controller never sees a row,
//  an overlay card or the URL bar.
// ============================================================================

import * as THREE from 'three';
import { ANATOMY_MODELS, DEFAULT_MODEL_ID, modelById, resolveModelId, structureMeta, presetOf } from './anatomy-models.js';
import { normalizeGroup, fitBox } from './framing.js';
import { makeMaterial, setObjectOpacity, disposeObject } from './materials.js';
import { updateBounds, applyRenderModeToPane, buildCaps } from './clipping.js';

// Frame the left pane on the globe rather than on everything: the optic nerve
// runs ~8 mm past the sclera, and fitting that whole extent shrinks the eye
// itself. Padded a little so the nerve still reads as it leaves the frame.
// Open on a three-quarter anterior view: the model's cornea sits at -X, so
// looking in from -X (and a little above and to the front) puts the cornea,
// iris and pupil facing the viewer. A straight lateral view just shows a
// featureless white globe.
export const ANATOMY_VIEW_DIR = new THREE.Vector3(-0.72, 0.26, 0.64);

/**
 * Reference-eye controller for the glb pane (and the stl workspace in overlay).
 *
 * @param {object} ctx
 * @param {{ glb: object, stl: object }} ctx.panes the two panes from createPane
 * @param {object} ctx.view the live view state ({ renderMode, layout, solidFill, clipState, … })
 * @param {{ fitStl: Function }} ctx.layers the stl LayerController (overlay refit)
 * @param {{ fetchBuffer: Function, isCached: Function }} ctx.io
 * @param {{ parseAnatomyGLTF: Function }} ctx.parsers
 * @param {{ emit: Function }} ctx.emitter
 * @param {object} [options]
 * @param {string|null} [options.modelId] the `?model=` value; resolved through resolveModelId
 * @param {string|null} [options.anatomyUrl] the `?anatomy=` value; overrides the model's file outright
 */
export class AnatomyController {
  constructor({ panes, view, layers, io, parsers, emitter }, { modelId = null, anatomyUrl = null } = {}) {
    this.glb = panes.glb;
    this.stl = panes.stl;
    this.view = view;
    this.layers = layers;
    this.io = io;
    this.parsers = parsers;
    this.emitter = emitter;

    // Which reference model the left pane is showing. `?model=<id>` picks one
    // at load; `?anatomy=<url>` still overrides the file outright, for a model
    // that isn't in the registry.
    this.activeModelId = resolveModelId(modelId);
    this.anatomyUrl = anatomyUrl || null;

    // The loaded scene, its overlay wrapper (a normalised group under
    // stl.root in overlay layout) and the pane-level offset / opacity.
    this._group = new THREE.Group();
    this._object = null;
    this._offset = { x: 0, y: 0, z: 0 };
    this._opacity = 1;
    this.controller = null;             // AbortController while a load is in flight

    this._parts = new Map();            // key -> THREE.Mesh
    this.stateMap = new Map();          // key -> { visible, color, opacity }
    this._preset = 'whole';
  }

  // -------------------------------------------------------------------------
  //  Read access for the app
  // -------------------------------------------------------------------------
  get object() { return this._object; }
  get group() { return this._group; }
  /** The live key → Mesh map; read `.size` / `.get` / `.has` / `.keys()` only. */
  get parts() { return this._parts; }
  get preset() { return this._preset; }
  get opacity() { return this._opacity; }
  get offset() { return { ...this._offset }; }
  get loading() { return this.controller !== null; }

  modelId() { return this.activeModelId; }
  model() { return modelById(this.activeModelId) || ANATOMY_MODELS[0]; }
  url() { return this.anatomyUrl || this.model().url; }
  presets() { return this.model().presets || {}; }
  // The model's structures that matched a mesh, in registry order.
  structures() { return this.model().structures.filter((s) => this._parts.has(s.key)); }

  state() {
    return Object.freeze({
      modelId: this.activeModelId,
      url: this.url(),
      preset: this._preset,
      opacity: this._opacity,
      offset: Object.freeze({ ...this._offset }),
      visible: this._object ? this._object.visible : true,
      partKeys: Object.freeze([...this._parts.keys()]),
      loading: this.controller !== null,
    });
  }

  // -------------------------------------------------------------------------
  //  Model switching and loading
  // -------------------------------------------------------------------------
  // Switch models: drop the current one entirely (geometry, materials, per-
  // structure state) and load the new one in its place.
  async setModel(id) {
    if (!modelById(id) || id === this.activeModelId) return;
    this.controller?.abort();
    this.activeModelId = id;

    if (this._object) {
      this._object.parent?.remove(this._object);
      disposeObject(this._object);
      this._object = null;
    }
    this._parts.clear();
    this.stateMap.clear();
    this._preset = 'whole';
    this.glb.root.clear();

    this.emitter.emit('anatomy:model', { id, model: this.model(), isDefault: id === DEFAULT_MODEL_ID, preset: 'whole' });
    return this.load();
  }

  // Download, parse and place the active model. Never rejects: a failure is
  // reported as anatomy:status error, an abort as anatomy:status idle (the
  // only place idle is emitted — cancel() itself says nothing).
  async load() {
    const url = this.url();
    this.controller = new AbortController();
    this.emitter.emit('anatomy:status', { state: 'loading', phase: 'start', pct: 0 });
    try {
      const buffer = await this.io.fetchBuffer(url, {
        signal: this.controller.signal,
        onProgress: ({ loaded, total, fromCache }) => {
          if (fromCache) return this.emitter.emit('anatomy:status', { state: 'loading', phase: 'download', pct: 100, loaded, total, fromCache: true });
          const pct = total ? Math.round((loaded / total) * 100) : 0;
          this.emitter.emit('anatomy:status', { state: 'loading', phase: 'download', pct, loaded, total, fromCache: false });
        },
      });
      this.emitter.emit('anatomy:status', { state: 'loading', phase: 'build', pct: 100 });
      const scene = await this.parsers.parseAnatomyGLTF(buffer);
      this.glb.root.clear();
      this._object = scene;
      const { keys, unmatched } = this.registerParts(scene);
      this.emitter.emit('anatomy:parts', { modelId: this.activeModelId, keys, unmatched, preset: this._preset });
      this.place();
      this.emitter.emit('anatomy:status', { state: 'loaded' });
    } catch (err) {
      if (err.name === 'AbortError') { this.emitter.emit('anatomy:status', { state: 'idle' }); return; }
      console.error('Anatomy GLB failed:', err);
      this.emitter.emit('anatomy:status', { state: 'error', message: err.message });
    } finally {
      this.controller = null;
    }
  }

  // Cancel an in-flight download; the pane returns to idle through load()'s catch.
  cancel() { this.controller?.abort(); }

  // -------------------------------------------------------------------------
  //  Placement
  // -------------------------------------------------------------------------
  // Route the anatomy model to the correct place for the current layout:
  // its own left pane (split) or merged into the overlay workspace (overlay).
  place() {
    if (!this._object) return;
    this._object.parent?.remove(this._object);
    if (this.view.layout === 'overlay') {
      this._group.add(this._object);
      if (!this._group.parent) this.stl.root.add(this._group);
      normalizeGroup(this._group, this._offset);
      updateBounds(this.stl, this.view);
      this.layers.fitStl(1.7);
      applyRenderModeToPane(this.stl, this.view);
    } else {
      if (this._group.parent) this.stl.root.remove(this._group);
      this.glb.root.add(this._object);
      fitBox(this.glb, this.focusBox(), 1.75, ANATOMY_VIEW_DIR);
      updateBounds(this.glb, this.view);
      applyRenderModeToPane(this.glb, this.view);
    }
  }

  focusBox() {
    const box = new THREE.Box3();
    const globe = this._parts.get('sclera');
    if (globe && globe.visible) box.setFromObject(globe);
    if (box.isEmpty() && this._object) box.setFromObject(this._object);
    return box;
  }

  // -------------------------------------------------------------------------
  //  Structures — per-structure meshes, colour & opacity
  // -------------------------------------------------------------------------
  // Structure metadata for the model currently loaded.
  meta(key) { return structureMeta(this.model(), key); }

  stateFor(key) {
    let st = this.stateMap.get(key);
    if (!st) {
      const d = this.meta(key) || { color: 0xffffff, opacity: 1 };
      st = { visible: true, color: d.color, opacity: d.opacity };
      this.stateMap.set(key, st);
    }
    return st;
  }

  // Match each mesh in the GLB to its structure by glTF node name. The exporter
  // names both the node and the mesh, but a loader may hang the name on either,
  // so check the mesh and then walk up to the nearest named ancestor.
  keyOf(mesh) {
    for (let o = mesh; o; o = o.parent) {
      const k = (o.name || '').trim().toLowerCase();
      if (this.meta(k)) return k;
    }
    return null;
  }

  // Register the scene's meshes as structures; returns the matched keys (in
  // traversal order) and the names that matched nothing.
  registerParts(scene) {
    this._parts.clear();
    const unmatched = [];
    scene.traverse((o) => {
      if (!o.isMesh || o.userData.anatomyBackOf) return;
      const key = this.keyOf(o);
      if (key) { this._parts.set(key, o); o.userData.anatomyKey = key; }
      else unmatched.push(o.name || '(unnamed)');
    });

    if (!this._parts.size) {
      // A custom model supplied via ?anatomy= won't carry our node names. Leave it
      // alone rather than colouring it wrong — it still renders, just without the
      // per-structure panel.
      console.warn('Anatomy model has no recognised structure names; per-structure controls disabled.', unmatched);
      setObjectOpacity(scene, this._opacity);
      return { keys: [], unmatched };
    }
    if (unmatched.length) console.warn('Anatomy meshes with no matching structure:', unmatched);

    for (const key of this._parts.keys()) this.applyStyle(key);
    return { keys: [...this._parts.keys()], unmatched };
  }

  // These structures are nested, near-convex shells that all share a centre, so
  // three.js's per-object back-to-front sort can't order them — every shell has a
  // near half and a far half at the same object distance, and the result is a
  // flat, obviously-wrong overlap. Render each translucent shell twice instead:
  // its back faces first (outermost shell first), then its front faces (innermost
  // first). That is the correct far-to-near order for concentric shells.
  //
  //   back faces:  10 + depth   (sclera 10, choroid 11, retina 12, lens 13 …)
  //   front faces: 90 - depth   (lens 87,   retina 88,  choroid 89, sclera 90)
  //
  // Opaque structures skip all of this and just depth-test normally.
  backMesh(mesh) {
    let back = mesh.userData.backMesh;
    if (!back) {
      back = new THREE.Mesh(mesh.geometry, makeMaterial(0xffffff, 1));
      back.material.userData.anatomy = true;
      back.frustumCulled = false;
      back.userData.anatomyBackOf = mesh.userData.anatomyKey;
      mesh.userData.backMesh = back;
      mesh.add(back);
    }
    return back;
  }

  // Effective alpha = the structure's own opacity x the pane-level anatomy opacity.
  applyStyle(key) {
    const mesh = this._parts.get(key);
    if (!mesh) return;
    const st = this.stateFor(key);
    const meta = this.meta(key);
    const depth = meta?.depth ?? 0;
    const alpha = st.opacity * this._opacity;
    const translucent = alpha < 0.999;

    if (!mesh.material?.userData?.anatomy) {
      mesh.material?.dispose?.();
      mesh.material = makeMaterial(st.color, alpha);
      mesh.material.userData.anatomy = true;
    }
    const m = mesh.material;
    m.color.setHex(st.color);
    m.roughness = meta?.rough ?? 0.72;
    m.opacity = alpha;
    m.transparent = translucent;
    m.depthWrite = !translucent;
    m.side = translucent ? THREE.FrontSide : THREE.DoubleSide;
    m.needsUpdate = true;
    mesh.renderOrder = translucent ? 90 - depth : 0;
    mesh.visible = st.visible;

    const back = this.backMesh(mesh);
    const bm = back.material;
    bm.color.setHex(st.color);
    bm.roughness = meta?.rough ?? 0.72;
    bm.opacity = alpha;
    bm.transparent = true;
    bm.depthWrite = false;
    bm.side = THREE.BackSide;
    bm.needsUpdate = true;
    back.renderOrder = 10 + depth;
    back.visible = translucent;
  }
  applyStyleAll() { for (const key of this._parts.keys()) this.applyStyle(key); }

  _emitStyle(key) {
    this.emitter.emit('anatomy:style', { key, state: { ...this.stateFor(key) } });
  }

  setPreset(name) {
    const model = this.model();
    const preset = presetOf(model, name);
    if (!preset) return;
    this._preset = name;
    for (const s of model.structures) {
      const st = this.stateFor(s.key);
      st.visible = !preset.hidden.includes(s.key);
      st.opacity = preset.opacity[s.key] ?? s.opacity;
    }
    this.applyStyleAll();
    for (const s of model.structures) this._emitStyle(s.key);
    this.emitter.emit('anatomy:preset', { name, preset });
    buildCaps(this.glb, this.view);
  }

  // Per-structure row controls. Visibility and colour rebuild the caps;
  // opacity only restyles.
  setVisible(key, on) {
    this.stateFor(key).visible = on;
    this.applyStyle(key);
    this._emitStyle(key);
    buildCaps(this.glb, this.view);
  }
  setColor(key, hex) {
    this.stateFor(key).color = hex;
    this.applyStyle(key);
    this._emitStyle(key);
    buildCaps(this.glb, this.view);
  }
  setOpacity(key, v) {
    this.stateFor(key).opacity = v;
    this.applyStyle(key);
    this._emitStyle(key);
  }

  // -------------------------------------------------------------------------
  //  Pane-level controls
  // -------------------------------------------------------------------------
  setPaneOpacity(v) {
    this._opacity = v;
    this.emitter.emit('anatomy:opacity', { value: v });
    if (!this._object) return;
    // Scale every structure's own alpha rather than flattening them all to one
    // value, so the model keeps its translucent-sclera / opaque-coats reading.
    if (this._parts.size) this.applyStyleAll();
    else setObjectOpacity(this._object, this._opacity);
  }

  setObjectVisible(on) {
    if (this._object) this._object.visible = on;
    this.emitter.emit('anatomy:visible', { on });
  }

  // Move the overlay wrapper on one axis (a fraction of the workspace size);
  // only re-normalised while the group is actually in the overlay.
  setOffset(ax, v) {
    this._offset[ax] = v;
    this.emitter.emit('anatomy:offset', { axis: ax, value: v, offset: { ...this._offset } });
    if (this.view.layout === 'overlay') { normalizeGroup(this._group, this._offset); updateBounds(this.stl, this.view); }
  }
}
