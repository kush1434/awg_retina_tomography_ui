// ============================================================================
//  materials.js — the one material recipe every mesh in the workbench uses,
//  plus the traversal helpers that recolour, re-opacify and dispose an object
//  tree. Three-only; the app never builds a MeshStandardMaterial itself.
// ============================================================================

import * as THREE from 'three';

export function makeMaterial(colorHex, opacity) {
  return new THREE.MeshStandardMaterial({
    color: colorHex, roughness: 0.82, metalness: 0.0,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide,
  });
}
export function applyColor(object, colorHex) {
  object.traverse((c) => { if (c.isMesh && c.material) c.material.color.setHex(colorHex); });
}
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
export function disposeObject(obj) {
  obj.traverse((c) => {
    if (c.isMesh) { c.geometry?.dispose(); if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose()); else c.material?.dispose(); }
  });
}
