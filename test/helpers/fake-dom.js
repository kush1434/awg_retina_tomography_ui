// ============================================================================
//  fake-dom.js — a deliberately small stand-in for the DOM so the app/ui view
//  modules can be exercised under `node --test` without jsdom. Elements record
//  what the views write to them (text, classes, dataset, style, attributes,
//  children, listeners); a subset of selectors is matched over real children,
//  and content set through innerHTML is opaque — querying into it yields a
//  memoised "virtual" child so handlers can still be attached and fired.
//  Static markup (index.html's ids) is created on demand by the document.
// ============================================================================

const TOKEN = /([#.]?[\w-]+|\[[^\]]+\])/g;

// Parse one compound selector ('input.slider[data-axis="x"]') into its parts.
function parseCompound(compound) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  for (const [tok] of compound.matchAll(TOKEN)) {
    if (tok.startsWith('#')) out.id = tok.slice(1);
    else if (tok.startsWith('.')) out.classes.push(tok.slice(1));
    else if (tok.startsWith('[')) {
      const m = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(tok);
      out.attrs.push({ name: m[1], value: m[2] });
    } else out.tag = tok.toLowerCase();
  }
  return out;
}

function matchesCompound(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const { name, value } of c.attrs) {
    const actual = el.getAttribute(name);
    if (actual === null) return false;
    if (value !== undefined && actual !== value) return false;
  }
  return true;
}

// Descendant combinators only ('#a .b input') — enough for the viewer's selectors.
function matchesSelector(el, selector) {
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  if (!matchesCompound(el, parts.pop())) return false;
  let node = el.parent;
  while (parts.length && node) {
    if (matchesCompound(node, parts[parts.length - 1])) parts.pop();
    node = node.parent;
  }
  return parts.length === 0;
}

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    on ? this.set.add(name) : this.set.delete(name);
    return on;
  }
  toString() { return [...this.set].join(' '); }
}

export class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.parent = null;
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    this.textContent = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._html = '';
    this._virtual = new Map();
    this.scrolledInto = 0;
  }

  // className is the classList joined, as in the DOM.
  get className() { return this.classList.toString(); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }

  // Content set through innerHTML is opaque; it drops the real children.
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; this._virtual.clear(); }

  appendChild(el) {
    if (el.tagName === '#FRAGMENT') { for (const c of el.children.slice()) this.appendChild(c); el.children = []; return el; }
    el.remove();
    el.parent = this;
    this.children.push(el);
    return el;
  }
  append(...els) { els.forEach((e) => this.appendChild(e)); }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i !== -1) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  contains(el) { for (let n = el; n; n = n.parent) if (n === this) return true; return false; }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) {
    if (k === 'id') return this.id || null;
    if (k === 'class') return this.className || null;
    if (k.startsWith('data-')) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return key in this.dataset ? String(this.dataset[key]) : null;
    }
    return k in this.attributes ? this.attributes[k] : null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  /** Fire `type` on this element; returns the listeners' return values (promises included). */
  dispatch(type, event = {}) {
    const e = { type, target: this, ...event };
    const out = [];
    for (const fn of this.listeners.get(type) || []) out.push(fn(e));
    if (typeof this['on' + type] === 'function') out.push(this['on' + type](e));
    return out;
  }
  click() { return this.dispatch('click'); }

  /** Every descendant (real children only) matching `selector`. */
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => { for (const c of node.children) { if (matchesSelector(c, selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  /** First real match; a memoised virtual child when the content came from innerHTML; else null. */
  querySelector(selector) {
    const hit = this.querySelectorAll(selector)[0];
    if (hit) return hit;
    if (!this._html) return null;
    if (!this._virtual.has(selector)) {
      const v = new FakeElement('virtual');
      v.parent = this; v.selector = selector;
      this._virtual.set(selector, v);
    }
    return this._virtual.get(selector);
  }
  getBoundingClientRect() { return { left: 12, top: 0, right: 112, bottom: 30, width: 100, height: 30 }; }
  scrollIntoView() { this.scrolledInto++; }
  /** Recursively collected text: own textContent plus the children's. */
  get deepText() { return [this.textContent, ...this.children.map((c) => c.deepText)].filter(Boolean).join(' '); }
}

export class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.listeners = new Map();
    this.raf = [];
  }
  createElement(tag) { return new FakeElement(tag); }
  createDocumentFragment() { return new FakeElement('#fragment'); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  /**
   * A real match under body, else — for a single compound selector — a new
   * element shaped by that selector, appended to body (index.html's static
   * markup, created on demand).
   */
  querySelector(selector) {
    const hit = this.body.querySelectorAll(selector)[0];
    if (hit) return hit;
    if (/\s/.test(selector.trim())) return null;
    const c = parseCompound(selector);
    const el = new FakeElement(c.tag || 'div');
    if (c.id) el.id = c.id;
    el.classList.add(...c.classes);
    for (const { name, value } of c.attrs) {
      if (name.startsWith('data-')) el.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value ?? '';
      else el.setAttribute(name, value ?? '');
    }
    this.body.appendChild(el);
    return el;
  }
  /** Shorthand used by the tests: the (possibly auto-created) static element. */
  el(selector) { return this.querySelector(selector); }
}

/**
 * Install a fake `document` plus a queued `requestAnimationFrame`; returns
 * the document, a `flushRaf()` that runs the queued callbacks, and `restore()`.
 */
export function installFakeDom() {
  const saved = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, setTimeout: globalThis.setTimeout };
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.requestAnimationFrame = (fn) => { doc.raf.push(fn); return doc.raf.length; };
  // Timers the views schedule (a toast's 6 s hide) are cleared on restore so a
  // test file does not linger; a test that enables mock timers replaces this
  // wrapper for its own duration.
  const timers = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => { const h = saved.setTimeout(fn, ms, ...args); timers.add(h); return h; };
  const flushRaf = () => { const q = doc.raf.splice(0); q.forEach((fn) => fn(0)); return q.length; };
  const restore = () => {
    timers.forEach(clearTimeout);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  };
  return { doc, flushRaf, restore };
}

/** Let queued microtasks and already-due macrotasks run. */
export const tick = () => new Promise((r) => setImmediate(r));

/** Poll `pred` on a timer until it holds (or `ms` elapse — then the caller's assertion reports). */
export async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
}
