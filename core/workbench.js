// ============================================================================
//  workbench.js — the facade over the whole core: the two panes, the camera
//  sync, the layer and anatomy controllers and — with one owner — the view
//  state (render mode, layout, global opacity, auto-rotate, linked offsets,
//  solid fill, grid, clip state). Every setter mutates the view, reports the
//  transition through the emitter and re-applies it to the panes; tick(now)
//  is the frame body the app calls from its animation loop. Three-only: the
//  renderer and the controls come from injected `adapters`, bytes from the
//  injected `io`, and the app renders every event — the workbench never sees
//  a button, a checkbox or a clock (the caller passes `now`).
// ============================================================================

import * as THREE from 'three';
import { createEmitter } from './emitter.js';
import { createPane } from './pane.js';
import { CameraSync } from './orientation.js';
import { fitBox, fitToObject } from './framing.js';
import { createClipState, updateBounds, updateClips, applyRenderModeToPane } from './clipping.js';
import { createLoaders, createMeshParsers } from './mesh-parsers.js';
import { LayerController } from './layers.js';
import { AnatomyController, ANATOMY_VIEW_DIR } from './anatomy.js';

const AXES = ['x', 'y', 'z'];

// A frozen copy of the clip state — the `clip` payload and the `state()` field.
function clipSnapshot(c) {
  const out = { flip: c.flip, showPlanes: c.showPlanes };
  for (const ax of AXES) out[ax] = Object.freeze({ on: c[ax].on, pos: c[ax].pos });
  return Object.freeze(out);
}

/**
 * Build a workbench.
 *
 * @param {object} opts
 * @param {object} opts.adapters either one `{ createRenderer, createControls }`
 *   shared by both panes or `{ glb: adapters, stl: adapters }` per pane.
 *   Required — createPane throws without it.
 * @param {{ fetchBuffer: Function, isCached: Function }} opts.io the asset
 *   I/O the layer and anatomy controllers download through.
 * @param {object} [opts.loaders] from createLoaders(); built when omitted
 * @param {object} [opts.parsers] from createMeshParsers(); built when omitted
 * @param {string|null} [opts.modelId] the `?model=` value for the anatomy
 * @param {string|null} [opts.anatomyUrl] the `?anatomy=` override
 * @param {number} [opts.startTime=0] seeds the fps window (the app passes its clock)
 */
export function createWorkbench({ adapters, io, loaders, parsers, modelId = null, anatomyUrl = null, startTime = 0 } = {}) {
  // -------------------------------------------------------------------------
  //  View state — one owner. `sync` deliberately lives on CameraSync only.
  // -------------------------------------------------------------------------
  const view = {
    renderMode: 'surface',                            // surface | wireframe | slices
    layout: 'split',                                  // split | overlay
    globalOpacity: 1,
    autoRotate: false,
    linkOffsets: false,                               // move all sample offsets together
    solidFill: false,                                 // default OFF: show the original individual coats; toggle on for the filled+capped view
    grid: false,
    clipState: createClipState(),
  };

  const emitter = createEmitter();
  parsers = parsers || createMeshParsers(loaders || createLoaders());

  // -------------------------------------------------------------------------
  //  Panes
  // -------------------------------------------------------------------------
  // The anatomy pane gets a camera-tracking headlight (tick moves it); the
  // segmented-coat pane gets solid cross-section caps when sliced.
  const paneAdapters = (id) => adapters?.[id] || adapters;
  const glb = createPane({ id: 'glb', headLight: true, adapters: paneAdapters('glb') });
  const stl = createPane({ id: 'stl', capsEnabled: true, adapters: paneAdapters('stl') });
  const panes = { glb, stl };
  const paneList = [glb, stl];

  const sync = new CameraSync(glb, stl);
  const layers = new LayerController({ pane: stl, view, io, parsers, emitter });
  const anatomy = new AnatomyController({ panes, view, layers, io, parsers, emitter }, { modelId, anatomyUrl });

  // Status-bar counters.
  let lastStat = 0, frames = 0, fpsT = startTime, fps = 0;

  // -------------------------------------------------------------------------
  //  Render mode / layout
  // -------------------------------------------------------------------------
  const applyRenderModeAll = () => paneList.forEach((p) => applyRenderModeToPane(p, view));
  const updateClipsAll = () => paneList.forEach((p) => updateClips(p, view));
  const emitClip = () => emitter.emit('clip', clipSnapshot(view.clipState));

  function setRenderMode(mode) {
    view.renderMode = mode;
    // Entering Slices with nothing cut shows no slice — enable one for discoverability.
    if (mode === 'slices' && !view.clipState.x.on && !view.clipState.y.on && !view.clipState.z.on) {
      view.clipState.x.on = true;
      emitClip();
      updateClipsAll();
    }
    emitter.emit('rendermode', { mode });
    applyRenderModeAll();
  }

  // The app re-measures the panes after they reflow (on its own timers) and
  // then calls refitAfterReflow with the mode it captured here.
  function setLayout(mode) {
    view.layout = mode;
    emitter.emit('layout', { layout: mode });
    anatomy.place();
    applyRenderModeAll();
  }

  function refitAfterReflow(layoutAtSwitch) {
    if (layers.groupCount() || anatomy.object) { updateBounds(stl, view); layers.fitStl(layoutAtSwitch === 'overlay' ? 1.7 : 1.45); }
  }

  // -------------------------------------------------------------------------
  //  Slicing / clipping
  // -------------------------------------------------------------------------
  function setClipAxis(ax, on) { view.clipState[ax].on = on; emitClip(); updateClipsAll(); }
  function setClipPos(ax, frac) { view.clipState[ax].pos = frac; emitClip(); updateClipsAll(); }
  function setClipFlip(on) { view.clipState.flip = on; emitClip(); updateClipsAll(); }
  function setShowPlanes(on) { view.clipState.showPlanes = on; emitClip(); applyRenderModeAll(); }

  // -------------------------------------------------------------------------
  //  Sync (mirror orbit orientation only), auto-rotate, grid
  // -------------------------------------------------------------------------
  function setSync(on) {
    emitter.emit('sync', { on });
    if (on) sync.link(); else sync.unlink();
  }

  function setAutoRotate(on) {
    view.autoRotate = on;
    paneList.forEach((p) => { p.controls.autoRotate = on; });
    emitter.emit('autorotate', { on });
  }

  function setGrid(on) {
    view.grid = on;
    paneList.forEach((p) => { p.grid.visible = on && !p.bounds.isEmpty(); });
    emitter.emit('grid', { on });
  }

  // -------------------------------------------------------------------------
  //  Display controls that delegate to the layer controller
  // -------------------------------------------------------------------------
  function setGlobalOpacity(v) {
    view.globalOpacity = v;
    layers.reapplyAllOpacity();
    emitter.emit('opacity', { global: v });
  }

  function setLinkOffsets(on) {
    view.linkOffsets = on;
    if (view.linkOffsets) layers.snapOffsetsToFirst();   // snap every sample to the first sample's offset
    emitter.emit('linkoffsets', { on });
  }

  function setSolidFill(on) {
    view.solidFill = on;
    emitter.emit('solidfill', { on });
    return layers.reloadFillVariants();
  }

  // -------------------------------------------------------------------------
  //  Camera framing
  // -------------------------------------------------------------------------
  // The anatomy pane frames on the globe along ANATOMY_VIEW_DIR (see
  // core/anatomy.js for why); the workspace frames on its sample groups.
  function resetPane(id) {
    const pane = panes[id];
    if (pane === stl) layers.fitStl(view.layout === 'overlay' ? 1.7 : 1.45);
    else if (anatomy.parts.size) fitBox(pane, anatomy.focusBox(), 1.75, ANATOMY_VIEW_DIR);
    else if (pane.root.children.length && fitToObject(pane, pane.root)) updateBounds(pane, view);
  }
  function resetAll() { resetPane('glb'); resetPane('stl'); }

  function resize(id, w, h) { panes[id].resize(w, h); }

  // -------------------------------------------------------------------------
  //  Frame body + status bar
  // -------------------------------------------------------------------------
  // `now` is the caller's clock in milliseconds (performance.now() in the
  // browser); fps is averaged over 500 ms windows seeded from `startTime`,
  // and a `stats` event leaves at most every 250 ms.
  function tick(now) {
    glb.controls.update();
    stl.controls.update();
    if (glb.headLight) {
      glb.headLight.position.copy(glb.camera.position);
      glb.headLight.target.position.copy(glb.controls.target);
      glb.headLight.target.updateMatrixWorld();
    }
    glb.render();
    stl.render();

    frames++;
    if (now - fpsT >= 500) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
    if (now - lastStat >= 250) {
      lastStat = now;
      const az = Math.round(THREE.MathUtils.radToDeg(stl.controls.getAzimuthalAngle()));
      const el = Math.round(90 - THREE.MathUtils.radToDeg(stl.controls.getPolarAngle()));
      const triangles = (glb.renderer.info.render.triangles + stl.renderer.info.render.triangles);
      emitter.emit('stats', { az, el, triangles, fps });
    }
  }

  // -------------------------------------------------------------------------
  //  Read access + teardown
  // -------------------------------------------------------------------------
  // A frozen copy of the view; `sync` is derived from CameraSync (its only owner).
  function state() {
    return Object.freeze({
      renderMode: view.renderMode,
      layout: view.layout,
      globalOpacity: view.globalOpacity,
      autoRotate: view.autoRotate,
      linkOffsets: view.linkOffsets,
      solidFill: view.solidFill,
      grid: view.grid,
      sync: sync.enabled,
      clipState: clipSnapshot(view.clipState),
    });
  }

  function dispose() {
    sync.unlink();
    anatomy.cancel();
    layers.abortAll();
    glb.dispose();
    stl.dispose();
  }

  return {
    panes, sync, layers, anatomy,
    setRenderMode, setLayout, refitAfterReflow,
    setClipAxis, setClipPos, setClipFlip, setShowPlanes,
    setSync, setAutoRotate, setGrid,
    setGlobalOpacity, setLinkOffsets, setSolidFill,
    resetPane, resetAll, applyRenderModeAll, resize, tick,
    state, dispose,
    on: emitter.on, off: emitter.off, once: emitter.once,
  };
}
