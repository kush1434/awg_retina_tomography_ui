// ============================================================================
//  Tests for core/anatomy-models.js — the model registry, the `?model=`
//  fallback rule, structure/preset lookups and the internal consistency of
//  every shipped model (presets only name structures the model actually has).
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRUCTURE_STYLES, muscle, struct, ANATOMY_MODELS, DEFAULT_MODEL_ID,
  modelById, resolveModelId, structureMeta, presetOf,
} from '../../core/anatomy-models.js';

const available = ANATOMY_MODELS.filter((m) => !m.unavailable);
const unavailable = ANATOMY_MODELS.filter((m) => m.unavailable);

describe('registry shape', () => {
  test('ships three renderable models and six surveyed-but-unavailable ones', () => {
    assert.deepEqual(available.map((m) => m.id), ['mesheye', 'humaneye', 'upat']);
    assert.deepEqual(unavailable.map((m) => m.id), ['isetbio', 'openretina', 'vcornea', 'openeyesim', 'p2p', 'osb']);
  });

  test('the default model is the first available one', () => {
    assert.equal(DEFAULT_MODEL_ID, 'mesheye');
    assert.equal(modelById(DEFAULT_MODEL_ID), ANATOMY_MODELS[0]);
  });

  test('every available model carries a url, focus structure, structures and a "whole" preset', () => {
    for (const m of available) {
      assert.match(m.url, /^optimized\/anatomy\/.+\.glb$/, m.id);
      assert.ok(m.structures.length > 0, `${m.id} has structures`);
      assert.ok(m.structures.some((s) => s.key === m.focus), `${m.id} focus '${m.focus}' is one of its structures`);
      assert.ok(m.presets.whole, `${m.id} has a 'whole' preset`);
      assert.deepEqual(m.presets.whole.hidden, []);
      assert.deepEqual(m.presets.whole.opacity, {});
    }
  });

  test('every unavailable model states its reason and ships no geometry', () => {
    for (const m of unavailable) {
      assert.equal(typeof m.unavailable, 'string', m.id);
      assert.ok(m.unavailable.length > 0, m.id);
      assert.equal(m.url, undefined, m.id);
      assert.equal(m.structures, undefined, m.id);
    }
  });
});

describe('modelById', () => {
  test('finds an available model by id', () => {
    assert.equal(modelById('upat').label, 'Upatras oculomotor');
    assert.equal(modelById('humaneye').url, 'optimized/anatomy/human-eye-cad.glb');
  });

  test('is undefined for the six unavailable ids and for unknown/missing ids', () => {
    for (const id of ['isetbio', 'openretina', 'vcornea', 'openeyesim', 'p2p', 'osb']) {
      assert.equal(modelById(id), undefined, id);
    }
    assert.equal(modelById('nope'), undefined);
    assert.equal(modelById(null), undefined);
    assert.equal(modelById(undefined), undefined);
  });
});

describe('resolveModelId (the ?model= rule)', () => {
  test('keeps an available id', () => {
    assert.equal(resolveModelId('upat'), 'upat');
    assert.equal(resolveModelId('humaneye'), 'humaneye');
    assert.equal(resolveModelId('mesheye'), 'mesheye');
  });

  test('falls back to the default for an unavailable, unknown or missing id', () => {
    assert.equal(resolveModelId('isetbio'), 'mesheye');   // listed, but no geometry
    assert.equal(resolveModelId('bogus'), 'mesheye');
    assert.equal(resolveModelId(''), 'mesheye');
    assert.equal(resolveModelId(null), 'mesheye');        // URLSearchParams.get() of a missing param
    assert.equal(resolveModelId(undefined), 'mesheye');
  });
});

describe('muscle / struct', () => {
  test('muscle() builds an extraocular-muscle style around the label', () => {
    const m = muscle('Lateral rectus');
    assert.deepEqual(m, { label: 'Lateral rectus', group: 'Extraocular muscles', color: 0xb84540, opacity: 1, rough: 0.66, depth: 0 });
  });

  test('struct() expands string keys from STRUCTURE_STYLES and [key, label] pairs into muscles', () => {
    const out = struct(['sclera', ['medial_rectus', 'Medial rectus']]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { key: 'sclera', ...STRUCTURE_STYLES.sclera });
    assert.equal(out[0].coat, true);
    assert.equal(out[0].depth, 0);
    assert.deepEqual(out[1], { key: 'medial_rectus', ...muscle('Medial rectus') });
    assert.equal(out[1].coat, undefined);
  });

  test('struct() copies the style so callers cannot mutate STRUCTURE_STYLES through it', () => {
    const [s] = struct(['retina']);
    s.color = 0x000000;
    assert.equal(STRUCTURE_STYLES.retina.color, 0xd9634c);
  });

  test('every STRUCTURE_STYLES entry has the fields the renderer relies on', () => {
    for (const [key, s] of Object.entries(STRUCTURE_STYLES)) {
      assert.equal(typeof s.label, 'string', key);
      assert.equal(typeof s.group, 'string', key);
      assert.ok(Number.isInteger(s.color) && s.color >= 0 && s.color <= 0xffffff, `${key} color`);
      assert.ok(s.opacity > 0 && s.opacity <= 1, `${key} opacity`);
      assert.ok(s.rough >= 0 && s.rough <= 1, `${key} rough`);
      assert.ok(Number.isInteger(s.depth) && s.depth >= 0, `${key} depth`);
    }
  });
});

describe('structureMeta / presetOf', () => {
  const mesheye = modelById('mesheye');
  const upat = modelById('upat');

  test('structureMeta returns the structure record for a key the model has', () => {
    const lamina = structureMeta(mesheye, 'lamina');
    assert.equal(lamina.label, 'Lamina cribrosa');
    assert.equal(lamina.group, 'Optic nerve head');
    assert.equal(structureMeta(upat, 'superior_oblique').label, 'Superior oblique');
  });

  test('structureMeta is undefined for a key another model has, or nothing has', () => {
    assert.equal(structureMeta(mesheye, 'superior_oblique'), undefined);
    assert.equal(structureMeta(upat, 'lamina'), undefined);
    assert.equal(structureMeta(mesheye, 'nope'), undefined);
    assert.equal(structureMeta(mesheye, ''), undefined);
  });

  test('presetOf returns the named preset, undefined otherwise, and tolerates a model with no presets', () => {
    assert.equal(presetOf(mesheye, 'coats').label, 'Coats');
    assert.deepEqual(presetOf(mesheye, 'coats').hidden, ['cornea', 'aqueous', 'iris', 'lens', 'vitreous']);
    assert.equal(presetOf(upat, 'recti').desc, 'The four recti only');
    assert.equal(presetOf(mesheye, 'recti'), undefined);
    assert.equal(presetOf(upat, 'coats'), undefined);
    assert.equal(presetOf({ structures: [] }, 'whole'), undefined);
  });
});

describe('preset consistency', () => {
  for (const m of available) {
    test(`${m.id}: every preset hidden[] and opacity{} key names one of its structures`, () => {
      const keys = new Set(m.structures.map((s) => s.key));
      for (const [name, p] of Object.entries(m.presets)) {
        assert.equal(typeof p.label, 'string', `${m.id}.${name} label`);
        assert.equal(typeof p.desc, 'string', `${m.id}.${name} desc`);
        for (const k of p.hidden) assert.ok(keys.has(k), `${m.id}.${name} hides unknown '${k}'`);
        for (const [k, v] of Object.entries(p.opacity)) {
          assert.ok(keys.has(k), `${m.id}.${name} sets opacity on unknown '${k}'`);
          assert.ok(v >= 0 && v <= 1, `${m.id}.${name}.${k} opacity ${v}`);
        }
      }
    });
  }

  test('structure keys are unique within each model', () => {
    for (const m of available) {
      const keys = m.structures.map((s) => s.key);
      assert.equal(new Set(keys).size, keys.length, m.id);
    }
  });
});
