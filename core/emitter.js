// ============================================================================
//  emitter.js — the one channel the core library uses to talk outward. Every
//  UI-visible transition (render mode, layout, layer/anatomy loading state…)
//  is emitted here and rendered by the app layer; the core never touches DOM.
// ============================================================================

/**
 * Create a minimal synchronous event emitter.
 *
 * Listeners run in registration order, on the emitting call stack, and an
 * exception thrown by a listener propagates to the emitter — exactly the
 * behaviour of the inline DOM updates this replaces. Synchronous delivery is
 * load-bearing: `anatomy:model` must land before `load()` starts and `layout`
 * before the panes are re-parented.
 *
 * @returns {{
 *   on:   (evt: string, fn: Function) => () => void,
 *   off:  (evt: string, fn: Function) => void,
 *   once: (evt: string, fn: Function) => () => void,
 *   emit: (evt: string, payload?: any) => void,
 * }}
 */
export function createEmitter() {
  const listeners = new Map();   // evt → Function[] in registration order

  function on(evt, fn) {
    if (typeof fn !== 'function') throw new TypeError(`listener for '${evt}' must be a function`);
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(fn);
    return () => off(evt, fn);
  }

  function off(evt, fn) {
    const list = listeners.get(evt);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
    if (!list.length) listeners.delete(evt);
  }

  function once(evt, fn) {
    const wrapped = (payload) => { off(evt, wrapped); fn(payload); };
    return on(evt, wrapped);
  }

  function emit(evt, payload) {
    const list = listeners.get(evt);
    if (!list) return;
    // Snapshot so a listener that (un)subscribes mid-emit cannot skip or
    // double-run a neighbour.
    for (const fn of list.slice()) fn(payload);
  }

  return { on, off, once, emit };
}
