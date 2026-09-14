// ============================================================================
//  materials.js — the one material recipe every mesh in the workbench uses,
//  plus the traversal helpers that recolour, re-opacify and dispose an object
//  tree. Three-only; the app never builds a MeshStandardMaterial itself.
// ============================================================================

import * as THREE from 'three';

/**
 * Builds the single material recipe every mesh in the workbench uses
 * (MeshStandardMaterial, roughness 0.82, metalness 0, DoubleSide).
 * @param {number} colorHex 0xRRGGBB
 * @param {number} opacity 0..1 — pass it explicitly: omitting it makes three
 *   warn and fall back to a fully opaque material. Below 1 it also sets
 *   `transparent` and turns `depthWrite` off.
 * @returns {THREE.MeshStandardMaterial} a fresh material per call; the caller
 *   owns disposal (see disposeObject).
 */
export function makeMaterial(colorHex, opacity) {
  return new THREE.MeshStandardMaterial({
    color: colorHex, roughness: 0.82, metalness: 0.0,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide,
  });
}

/**
 * Recolours every mesh in the subtree in place.
 * @param {THREE.Object3D} object
 * @param {number} colorHex 0xRRGGBB
 * @returns {void} Single-material meshes only — a mesh carrying an array
 *   material throws a TypeError. Unlike setObjectOpacity, this does not honour
 *   the `userData.noClip` exemption: helpers get recoloured too.
 */
export function applyColor(object, colorHex) {
  object.traverse((c) => { if (c.isMesh && c.material) c.material.color.setHex(colorHex); });
}

/**
 * Re-opacifies every mesh in the subtree, flipping `transparent`, `depthWrite`
 * and `needsUpdate` with it, and setting renderOrder to 1 when translucent and
 * 0 when opaque.
 * @param {THREE.Object3D} object
 * @param {number} o 0..1
 * @returns {void} Meshes flagged `userData.noClip` — slice quads, the box
 *   helper, the grid, the stencil caps — are skipped, so they keep the
 *   blending they set for themselves. Array materials are not handled.
 */
export function setObjectOpacity(object, o) {
  object.traverse((c) => {
    if (c.isMesh && c.material && !c.userData.noClip) {
      c.material.opacity = o;
      c.material.transparent = o < 1;
      c.material.depthWrite = o >= 1;
      c.renderOrder = o < 1 ? 1 : 0;
      c.material.needsUpdate = true;
    }
  });
}

/**
 * Disposes every mesh geometry and material in the subtree, array materials
 * included.
 * @param {THREE.Object3D} obj
 * @returns {void} Does not remove the object from its parent — detach first,
 *   as core/layers.js and core/anatomy.js do, or the scene keeps drawing a
 *   mesh whose GPU resources are gone.
 */
export function disposeObject(obj) {
  obj.traverse((c) => {
    if (c.isMesh) { c.geometry?.dispose(); if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose()); else c.material?.dispose(); }
  });
}
