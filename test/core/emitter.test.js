// ============================================================================
//  Tests for core/emitter.js — synchronous delivery, registration order,
//  unsubscribe/once semantics and the throw-propagation policy.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEmitter } from '../../core/emitter.js';

describe('createEmitter', () => {
  test('delivers synchronously, in registration order, with the payload', () => {
    const em = createEmitter();
    const log = [];
    em.on('x', (p) => log.push(['a', p]));
    em.on('x', (p) => log.push(['b', p]));
    em.emit('x', 42);
    assert.deepEqual(log, [['a', 42], ['b', 42]]);   // both ran before emit returned
  });

  test('emit with no listeners is a no-op', () => {
    const em = createEmitter();
    assert.doesNotThrow(() => em.emit('nothing', { a: 1 }));
  });

  test('on() returns an unsubscribe function', () => {
    const em = createEmitter();
    let n = 0;
    const off = em.on('x', () => n++);
    em.emit('x');
    off();
    em.emit('x');
    assert.equal(n, 1);
    assert.doesNotThrow(off);                          // idempotent
  });

  test('off() removes only that listener, and only for that event', () => {
    const em = createEmitter();
    const log = [];
    const a = () => log.push('a');
    const b = () => log.push('b');
    em.on('x', a);
    em.on('x', b);
    em.on('y', a);
    em.off('x', a);
    em.emit('x');
    em.emit('y');
    assert.deepEqual(log, ['b', 'a']);
    assert.doesNotThrow(() => em.off('x', a));         // already gone
    assert.doesNotThrow(() => em.off('zzz', a));       // never registered
  });

  test('once() fires exactly one time and can be cancelled beforehand', () => {
    const em = createEmitter();
    const seen = [];
    em.once('x', (p) => seen.push(p));
    em.emit('x', 1);
    em.emit('x', 2);
    assert.deepEqual(seen, [1]);

    let fired = false;
    const cancel = em.once('y', () => { fired = true; });
    cancel();
    em.emit('y');
    assert.equal(fired, false);
  });

  test('a once() listener may re-emit from inside its own callback', () => {
    const em = createEmitter();
    let count = 0;
    em.once('x', () => { count++; em.emit('x'); });   // must not recurse forever
    em.emit('x');
    assert.equal(count, 1);
  });

  test('a throwing listener propagates to the emitter and stops delivery', () => {
    const em = createEmitter();
    const log = [];
    em.on('x', () => log.push('before'));
    em.on('x', () => { throw new Error('boom'); });
    em.on('x', () => log.push('after'));
    assert.throws(() => em.emit('x'), /boom/);
    assert.deepEqual(log, ['before']);
    // The emitter is still usable afterwards.
    assert.throws(() => em.emit('x'), /boom/);
  });

  test('(un)subscribing during emit does not skip or double-run neighbours', () => {
    const em = createEmitter();
    const log = [];
    let offB;
    em.on('x', () => { log.push('a'); offB(); em.on('x', () => log.push('late')); });
    offB = em.on('x', () => log.push('b'));
    em.on('x', () => log.push('c'));
    em.emit('x');
    // The snapshot taken at emit time still includes b; the late listener
    // only joins the next emission.
    assert.deepEqual(log, ['a', 'b', 'c']);
    log.length = 0;
    em.emit('x');                                      // a adds a second 'late' → next emission only
    assert.deepEqual(log, ['a', 'c', 'late']);
  });

  test('the same function may be registered on several events', () => {
    const em = createEmitter();
    const seen = [];
    const fn = (p) => seen.push(p);
    em.on('a', fn);
    em.on('b', fn);
    em.emit('a', 'A');
    em.emit('b', 'B');
    assert.deepEqual(seen, ['A', 'B']);
  });

  test('rejects a non-function listener up front', () => {
    const em = createEmitter();
    assert.throws(() => em.on('x', null), TypeError);
    assert.throws(() => em.on('x', 'nope'), TypeError);
  });
});
