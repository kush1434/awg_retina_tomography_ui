// ============================================================================
//  index.js — the core library's public surface, one import for consumers
//  (`import { createWorkbench } from '<package>'` / `./core/index.js`). Pure
//  re-exports, nothing else: the module graph below this file is Three-only
//  and DOM-free. Deliberately NOT re-exported: core/adapters-headless.js (the
//  stub renderer + real OrbitControls used by the unit tests and by headless
//  consumers) — it is the package's `./headless` subpath so the browser app's
//  module graph never loads it — and the private helpers `struct`, `muscle`
//  (anatomy-models) and `stencilMat` (clipping).
// ============================================================================

export { createEmitter } from './emitter.js';

export {
  STRUCTURE_STYLES, ANATOMY_MODELS, DEFAULT_MODEL_ID, modelById, resolveModelId,
  structureMeta, presetOf,
} from './anatomy-models.js';

export { makeMaterial, applyColor, setObjectOpacity, disposeObject } from './materials.js';

export {
  OVERLAY_TARGET, localBox, normalizeGroup, fitDistance, fitBox, fitToObject, unionBoxOfGroups,
} from './framing.js';

export {
  createClipState, clipPlaneFor, sliceQuadPlacement, updateBounds, updateClips,
  applyRenderModeToPane, buildCaps, clearCaps, collectCapCoats,
} from './clipping.js';

export { PLANE_COLORS, createPane } from './pane.js';

export { applyOrientation, mirror, CameraSync } from './orientation.js';

export { createLoaders, createMeshParsers } from './mesh-parsers.js';

export { HEAVY_BYTES, solidVariant, effectivePath, LayerController } from './layers.js';

export { ANATOMY_VIEW_DIR, AnatomyController } from './anatomy.js';

export { createWorkbench } from './workbench.js';
