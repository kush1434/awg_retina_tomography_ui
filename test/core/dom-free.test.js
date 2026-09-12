// ============================================================================
//  dom-free.test.js — static scan guaranteeing that nothing under core/ reaches
//  for a browser global, a timer, the network, or an app-layer helper. Node has
//  `performance`, `navigator` and `fetch` itself, so a runtime check would let
//  those through; the scan is over source text with comments stripped. The
//  scan also follows each module's imports: reading one file's own text would
//  miss an app-layer module pulled into the graph behind it.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core');

// `fetch` / `caches` enforce the io-injection contract; `console` is allowed.
// `WebGLRenderer` and the element / observer / dialog calls are the non-headless
// surface the plan puts behind the adapters, so they are forbidden by name too —
// a DOM element arriving through an adapter and then being manipulated is the
// realistic leak, and it never mentions `document`.
const FORBIDDEN = /\b(document|window|self|location|history|navigator|URLSearchParams|matchMedia|getComputedStyle|querySelector|classList|innerHTML|createElement|getElementById|getElementsBy\w+|appendChild|removeChild|getBoundingClientRect|devicePixelRatio|WebGLRenderer|requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|clearTimeout|clearInterval|performance|ResizeObserver|MutationObserver|IntersectionObserver|fetch|caches|XMLHttpRequest|Worker|localStorage|sessionStorage|indexedDB|confirm|alert|prompt|toast|askConfirm|renderOverlay|setRowState|build[A-Z]\w*Tree)\b/;

// Only `three` itself and a sibling core module may be imported: everything
// else (app/ui, the browser adapters) can drag a DOM into the graph.
const IMPORTS = /(?:^|[\s;}])(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
const allowedSpecifier = (spec) => spec === 'three' || spec.startsWith('three/addons/') || /^\.\/[\w-]+\.js$/.test(spec);

/**
 * Blank out line (`//`) and block comments, keeping line numbers intact.
 * String, template and regex literals are stepped over whole rather than
 * scanned for a comment opener: a URL literal ('https://…') would otherwise
 * blank every token after it on its line, and a quote inside a regex would
 * swallow the rest of the file. Their contents stay in the output, so an
 * identifier hidden in a string is still caught.
 */
export function stripComments(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '; };
  const code = [];                  // the significant text so far (regex vs. division)
  const opensRegex = () => /(^|[=(,:[!&|?{};+\-*%~^<>]|\b(?:return|typeof|instanceof|new|delete|void|in|of|case|yield|await))\s*$/.test(code.join(''));

  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const end = src.indexOf('\n', i); const stop = end < 0 ? src.length : end; blank(i, stop); i = stop; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2; blank(i, stop); i = stop; continue; }

    const c = src[i];
    if (c === '"' || c === "'" || c === '`' || (c === '/' && opensRegex())) {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      code.push(c, c);              // a literal counts as one value, whatever it holds
      i = Math.min(j + 1, src.length);
      continue;
    }
    code.push(c);
    i++;
  }
  return out.join('');
}

function coreFiles() {
  return readdirSync(CORE_DIR).filter((f) => f.endsWith('.js')).sort();
}

function importsOf(src) {
  const specs = [];
  for (const m of src.matchAll(IMPORTS)) specs.push(m[1] ?? m[2]);
  return specs;
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

  test('a `//` inside a string does not hide the rest of its line', () => {
    assert.match(stripComments("const p = 'http://x/'; const d = document;"), FORBIDDEN);
    assert.match(stripComments('const p = "https://x//y"; const d = window;'), FORBIDDEN);
    assert.match(stripComments('const p = `wss://x/`; el.innerHTML = 1;'), FORBIDDEN);
    // …and a real comment after one still goes.
    assert.doesNotMatch(stripComments("const p = 'http://x/';  // document\n"), FORBIDDEN);
  });

  test('a regex literal is stepped over, not mistaken for a comment or a string', () => {
    assert.match(stripComments("const m = p.match(/a\\/([^/?#]+)/i); const d = document;"), FORBIDDEN);
    assert.match(stripComments("const q = /['\"]/.test(s); const d = document;"), FORBIDDEN);
    // A division is not a regex: the trailing quote must not open a literal.
    assert.match(stripComments("const r = a / b; const s = 'x'; const d = document;"), FORBIDDEN);
  });

  test('the forbidden pattern catches a bare identifier but not a substring', () => {
    assert.match('const x = document.body;', FORBIDDEN);
    assert.match('buildAnatomyTree();', FORBIDDEN);
    assert.match('new THREE.WebGLRenderer()', FORBIDDEN);
    assert.match('el.appendChild(canvas)', FORBIDDEN);
    assert.match('new ResizeObserver(measure)', FORBIDDEN);
    assert.match('window.devicePixelRatio', FORBIDDEN);
    assert.match('el.ownerDocument', /ownerDocument/);
    assert.doesNotMatch('el.ownerDocument', FORBIDDEN);   // case-sensitive word match
    assert.doesNotMatch('const selfless = 1; myWindow();', FORBIDDEN);
  });

  test('the import pattern reads single-line, multi-line and bare specifiers', () => {
    assert.deepEqual(importsOf("import * as THREE from 'three';\nimport { a } from './x.js';"), ['three', './x.js']);
    assert.deepEqual(importsOf("export {\n  a, b,\n} from './y.js';"), ['./y.js']);
    assert.deepEqual(importsOf("import '../app/browser-adapters.js';"), ['../app/browser-adapters.js']);
    assert.equal(allowedSpecifier('three'), true);
    assert.equal(allowedSpecifier('three/addons/loaders/STLLoader.js'), true);
    assert.equal(allowedSpecifier('./materials.js'), true);
    assert.equal(allowedSpecifier('../app/browser-adapters.js'), false);
    assert.equal(allowedSpecifier('../../viewer.js'), false);
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

    test(`${file} imports only three or a sibling core module`, () => {
      const src = stripComments(readFileSync(join(CORE_DIR, file), 'utf8'));
      const bad = importsOf(src).filter((spec) => !allowedSpecifier(spec));
      assert.deepEqual(bad, [], `${file} reaches outside core/: ${bad.join(', ')}`);
    });
  }
});
