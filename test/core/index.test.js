// ============================================================================
//  Tests for core/index.js + the package `exports` map — the barrel exposes
//  exactly the documented surface (the same bindings the source modules
//  export, nothing headless-only, nothing private), the workbench builds
//  through it, and the package resolves its own subpaths the way a consumer
//  would (`import '<name>'`, `'<name>/headless'`, `'<name>/core/pane'`…).
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as core from '../../core/index.js';
import * as emitter from '../../core/emitter.js';
import * as anatomyModels from '../../core/anatomy-models.js';
import * as materials from '../../core/materials.js';
import * as framing from '../../core/framing.js';
import * as clipping from '../../core/clipping.js';
import * as pane from '../../core/pane.js';
import * as orientation from '../../core/orientation.js';
import * as meshParsers from '../../core/mesh-parsers.js';
import * as layers from '../../core/layers.js';
import * as anatomy from '../../core/anatomy.js';
import * as workbench from '../../core/workbench.js';
import { headlessAdapters } from '../../core/adapters-headless.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// The documented surface (plan §1.13): name → [source module, expected typeof].
const SURFACE = {
  createEmitter:         [emitter,       'function'],
  STRUCTURE_STYLES:      [anatomyModels, 'object'],
  ANATOMY_MODELS:        [anatomyModels, 'object'],
  DEFAULT_MODEL_ID:      [anatomyModels, 'string'],
  modelById:             [anatomyModels, 'function'],
  resolveModelId:        [anatomyModels, 'function'],
  structureMeta:         [anatomyModels, 'function'],
  presetOf:              [anatomyModels, 'function'],
  makeMaterial:          [materials,     'function'],
  applyColor:            [materials,     'function'],
  setObjectOpacity:      [materials,     'function'],
  disposeObject:         [materials,     'function'],
  OVERLAY_TARGET:        [framing,       'number'],
  localBox:              [framing,       'function'],
  normalizeGroup:        [framing,       'function'],
  fitDistance:           [framing,       'function'],
  fitBox:                [framing,       'function'],
  fitToObject:           [framing,       'function'],
  unionBoxOfGroups:      [framing,       'function'],
  createClipState:       [clipping,      'function'],
  clipPlaneFor:          [clipping,      'function'],
  sliceQuadPlacement:    [clipping,      'function'],
  updateBounds:          [clipping,      'function'],
  updateClips:           [clipping,      'function'],
  applyRenderModeToPane: [clipping,      'function'],
  buildCaps:             [clipping,      'function'],
  clearCaps:             [clipping,      'function'],
  collectCapCoats:       [clipping,      'function'],
  PLANE_COLORS:          [pane,          'object'],
  createPane:            [pane,          'function'],
  applyOrientation:      [orientation,   'function'],
  mirror:                [orientation,   'function'],
  CameraSync:            [orientation,   'function'],
  createLoaders:         [meshParsers,   'function'],
  createMeshParsers:     [meshParsers,   'function'],
  HEAVY_BYTES:           [layers,        'number'],
  solidVariant:          [layers,        'function'],
  effectivePath:         [layers,        'function'],
  LayerController:       [layers,        'function'],
  ANATOMY_VIEW_DIR:      [anatomy,       'object'],
  AnatomyController:     [anatomy,       'function'],
  createWorkbench:       [workbench,     'function'],
};

// Exported by a core module but intentionally kept off the barrel.
const NOT_ON_BARREL = ['headlessAdapters', 'stubElement', 'struct', 'muscle', 'stencilMat'];

describe('core/index.js barrel', () => {
  test('exports exactly the documented surface — no more, no less', () => {
    assert.deepEqual(Object.keys(core).sort(), Object.keys(SURFACE).sort());
    assert.equal(Object.keys(core).length, 42);
  });

  for (const [name, [source, type]] of Object.entries(SURFACE)) {
    test(`${name} is the source module's own binding (${type})`, () => {
      assert.equal(typeof core[name], type);
      assert.ok(name in source, `${name} must come from its documented module`);
      assert.equal(core[name], source[name]);   // same binding, not a copy or a wrapper
    });
  }

  test('classes are the real constructors, not stubs', () => {
    assert.equal(core.CameraSync.prototype.link, orientation.CameraSync.prototype.link);
    assert.ok(new core.CameraSync() instanceof orientation.CameraSync);
    assert.equal(core.LayerController.prototype.load, layers.LayerController.prototype.load);
    assert.equal(core.AnatomyController.prototype.setModel, anatomy.AnatomyController.prototype.setModel);
  });

  test('does not re-export the headless adapters or private helpers', () => {
    for (const name of NOT_ON_BARREL) assert.ok(!(name in core), `${name} must not be on the barrel`);
    // Confirms those names really are exports somewhere (so the test cannot pass vacuously).
    assert.equal(typeof headlessAdapters, 'function');
    assert.equal(typeof anatomyModels.struct, 'function');
    assert.equal(typeof anatomyModels.muscle, 'function');
    assert.equal(typeof clipping.stencilMat, 'function');
  });

  test('the barrel never imports adapters-headless.js (browser graph stays headless-free)', () => {
    const src = readFileSync(join(ROOT, 'core', 'index.js'), 'utf8');
    assert.doesNotMatch(src, /from\s+['"][^'"]*adapters-headless/);
    // Pure re-exports: every statement is an `export … from` and nothing else runs.
    const statements = src.replace(/\/\/[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
    assert.equal(statements.length, 11);   // one per source module
    for (const s of statements) assert.match(s, /^export\s*\{[\s\S]*\}\s*from\s*'\.\/[a-z-]+\.js'$/);
  });

  test('a workbench built through the barrel is the real thing', () => {
    const wb = core.createWorkbench({ adapters: headlessAdapters() });
    try {
      const s = wb.state();
      assert.equal(s.renderMode, 'surface');
      assert.equal(s.layout, 'split');
      assert.ok(wb.layers instanceof core.LayerController);
      assert.ok(wb.anatomy instanceof core.AnatomyController);
      assert.ok(wb.sync instanceof core.CameraSync);
      assert.equal(wb.panes.stl.camera.fov, 52);
      assert.equal(wb.anatomy.model().id, core.DEFAULT_MODEL_ID);
      assert.ok(core.modelById(core.DEFAULT_MODEL_ID));
    } finally {
      wb.dispose();
    }
  });
});

describe('package.json packaging', () => {
  test('exports map points "." at the barrel and "./headless" at the adapters', () => {
    assert.equal(pkg.exports['.'], './core/index.js');
    assert.equal(pkg.exports['./headless'], './core/adapters-headless.js');
    assert.equal(pkg.exports['./browser'], './app/browser-adapters.js');
    assert.equal(pkg.exports['./core/*'], './core/*.js');
    assert.equal(pkg.exports['./data-loader'], './data-loader.js');
    assert.equal(pkg.exports['./asset-loader'], './asset-loader.js');
    for (const [sub, target] of Object.entries(pkg.exports)) {
      if (sub.includes('*')) continue;
      assert.ok(existsSync(join(ROOT, target)), `${sub} → ${target} must exist`);
    }
  });

  test('files whitelist ships the library, its two I/O helpers and the browser seam only', () => {
    // The browser adapters are documented as `<name>/browser` (README: "Using
    // the core in your own page"), so they ship; the app/ui view modules and
    // viewer.js do not — a consumer brings its own.
    assert.deepEqual(pkg.files, ['core', 'app/browser-adapters.js', 'data-loader.js', 'asset-loader.js', 'README.md', 'LICENSE']);
    assert.ok(!pkg.files.includes('app'), 'app/ui is not part of the package');
    assert.ok(existsSync(join(ROOT, 'LICENSE')));
    assert.equal(pkg.sideEffects, false);
    assert.equal(pkg.type, 'module');
  });

  test('three is a peer dependency on the same range as the dev dependency', () => {
    assert.equal(pkg.peerDependencies.three, '^0.169.0');
    assert.equal(pkg.peerDependencies.three, pkg.devDependencies.three);
  });

  // Node lets a package import itself by name once it declares `exports`, so
  // these resolve through the real map — exactly what a consumer sees.
  test('the package resolves its own subpaths through the exports map', async () => {
    const main = await import(pkg.name);
    assert.deepEqual(Object.keys(main).sort(), Object.keys(core).sort());
    assert.equal(main.createWorkbench, core.createWorkbench);

    const headless = await import(`${pkg.name}/headless`);
    assert.equal(headless.headlessAdapters, headlessAdapters);
    assert.ok(!('createWorkbench' in headless));

    const paneSub = await import(`${pkg.name}/core/pane`);
    assert.equal(paneSub.createPane, core.createPane);

    const browser = await import(`${pkg.name}/browser`);
    assert.equal(typeof browser.browserAdapters, 'function');
    assert.equal(typeof browser.mountPane, 'function');
    assert.ok(!('createWorkbench' in browser));

    const dl = await import(`${pkg.name}/data-loader`);
    assert.equal(typeof dl.loadCSVData, 'function');
    const al = await import(`${pkg.name}/asset-loader`);
    assert.equal(typeof al.fetchBuffer, 'function');
  });

  test('paths outside the exports map are not reachable', async () => {
    await assert.rejects(() => import(`${pkg.name}/viewer.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(() => import(`${pkg.name}/app/browser-adapters.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  });
});
