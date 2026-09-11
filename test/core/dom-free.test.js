// ============================================================================
//  dom-free.test.js — static scan guaranteeing that nothing under core/ reaches
//  for a browser global, a timer, the network, or an app-layer helper. Node has
//  `performance`, `navigator` and `fetch` itself, so a runtime check would let
//  those through; the scan is over source text with comments stripped.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core');

// `fetch` / `caches` enforce the io-injection contract; `console` is allowed.
const FORBIDDEN = /\b(document|window|self|location|history|navigator|URLSearchParams|matchMedia|getComputedStyle|querySelector|classList|innerHTML|requestAnimationFrame|setTimeout|setInterval|performance|ResizeObserver|fetch|caches|XMLHttpRequest|Worker|localStorage|sessionStorage|indexedDB|toast|askConfirm|renderOverlay|setRowState|build[A-Z]\w*Tree)\b/;

// Blank out line (`//`) and block comments, keeping line numbers intact.
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function coreFiles() {
  return readdirSync(CORE_DIR).filter((f) => f.endsWith('.js')).sort();
}

describe('stripComments', () => {
  test('removes line and block comments without shifting lines', () => {
    const src = 'a // window\nb /* document\n setTimeout */ c\nd';
    const out = stripComments(src);
    assert.equal(out.split('\n').length, 4);
    assert.doesNotMatch(out, FORBIDDEN);
    assert.match(out, /^a\s*$/m);
    assert.match(out, /c$/m);
  });

  test('the forbidden pattern catches a bare identifier but not a substring', () => {
    assert.match('const x = document.body;', FORBIDDEN);
    assert.match('buildAnatomyTree();', FORBIDDEN);
    assert.match('el.ownerDocument', /ownerDocument/);
    assert.doesNotMatch('el.ownerDocument', FORBIDDEN);   // case-sensitive word match
    assert.doesNotMatch('const selfless = 1; myWindow();', FORBIDDEN);
  });
});

describe('core/ is DOM-free', () => {
  const files = coreFiles();

  test('there is at least one core module to scan', () => {
    assert.ok(files.length > 0, 'core/ must contain modules');
  });

  for (const file of files) {
    test(`${file} references no browser/app-layer global`, () => {
      const src = stripComments(readFileSync(join(CORE_DIR, file), 'utf8'));
      const hits = [];
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(FORBIDDEN.source, 'g'))) hits.push(`${file}:${i + 1} '${m[1]}' — ${line.trim()}`);
      });
      assert.deepEqual(hits, [], `forbidden identifiers:\n${hits.join('\n')}`);
    });
  }
});
