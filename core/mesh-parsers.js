// ============================================================================
//  mesh-parsers.js — turning a downloaded ArrayBuffer into a Three object.
//  createLoaders() builds the shared STL / GLTF / DRACO loader trio the way
//  the viewer always has; createMeshParsers() wraps them as three parsers:
//  parseSTL (a segmented layer as one mesh in its structure's colour),
//  parseGLTF (a segmented layer scene, every mesh re-skinned white) and
//  parseAnatomyGLTF (the reference eye, materials and node names kept). The
//  loaders never fetch — buffers arrive from the injected io — but a
//  Draco-compressed GLB still needs the decoder assets at `dracoDecoderPath`,
//  so those files are browser-only; headless tests use uncompressed GLBs.
// ============================================================================

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { makeMaterial } from './materials.js';

/**
 * The shared loaders: a DRACOLoader pointed at `dracoDecoderPath`, a
 * GLTFLoader wired to it, and an STLLoader.
 * @param {{ dracoDecoderPath?: string }} [opts]
 * @returns {{ dracoLoader: DRACOLoader, gltfLoader: GLTFLoader, stlLoader: STLLoader }}
 */
export function createLoaders({ dracoDecoderPath = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' } = {}) {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(dracoDecoderPath);
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);
  const stlLoader = new STLLoader();
  return { dracoLoader, gltfLoader, stlLoader };
}

/**
 * The three parsers over a set of loaders (see createLoaders).
 * @param {{ gltfLoader: GLTFLoader, stlLoader: STLLoader }} loaders
 * @returns {{ parseSTL: Function, parseGLTF: Function, parseAnatomyGLTF: Function }}
 */
export function createMeshParsers({ gltfLoader, stlLoader }) {
  function parseSTL(buffer, structure) {
    const geometry = stlLoader.parse(buffer);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, makeMaterial(structure.color, structure.opacity));
  }
  function parseGLTF(buffer) {
    return new Promise((resolve, reject) => {
      gltfLoader.parse(buffer, '', (gltf) => {
        gltf.scene.traverse((c) => {
          if (c.isMesh) {
            c.frustumCulled = false;
            if (!c.geometry.attributes.normal) c.geometry.computeVertexNormals();
            c.material = makeMaterial(0xffffff, 1);
          }
        });
        resolve(gltf.scene);
      }, reject);
    });
  }
  function parseAnatomyGLTF(buffer) {
    return new Promise((resolve, reject) => {
      gltfLoader.parse(buffer, '', (gltf) => {
        gltf.scene.traverse((c) => {
          if (!c.isMesh) return;
          c.frustumCulled = false;
          if (!c.geometry.attributes.normal) c.geometry.computeVertexNormals();
        });
        resolve(gltf.scene);
      }, reject);
    });
  }
  return { parseSTL, parseGLTF, parseAnatomyGLTF };
}
