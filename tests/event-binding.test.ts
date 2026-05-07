import { describe, expect, it, vi } from 'vitest';
import { createEventBinder } from '../js/modules/core/event-binding.js';

describe('createEventBinder', () => {
  it('returns a function', () => {
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);
    expect(typeof bind).toBe('function');
  });

  it('calls addEventListener on the target and invokes the handler when fired', () => {
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const handler = vi.fn();

    bind(target as unknown as EventTarget, 'click', handler);

    // Binder wraps the handler (to catch async rejections), so identity differs.
    // Verify the listener was registered for the right event type and that
    // invoking the wrapped listener delegates to the original handler.
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    const [type, registered] = target.addEventListener.mock.calls[0] as [string, EventListener];
    expect(type).toBe('click');

    const event = new Event('click');
    registered(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('pushes a cleanup function into the array', () => {
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };

    bind(target as unknown as EventTarget, 'click', vi.fn());

    expect(cleanups).toHaveLength(1);
    expect(typeof cleanups[0]).toBe('function');
  });

  it('cleanup removes the same wrapped listener that was added', () => {
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const handler = vi.fn();

    bind(target as unknown as EventTarget, 'input', handler);
    const [, registered] = target.addEventListener.mock.calls[0] as [string, EventListener];

    cleanups[0]?.();

    // removeEventListener must receive the exact wrapped function reference
    // that addEventListener saw, otherwise the listener would leak.
    expect(target.removeEventListener).toHaveBeenCalledWith('input', registered);
  });

  it('tracks multiple bindings independently', () => {
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);
    const target1 = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const target2 = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bind(target1 as unknown as EventTarget, 'click', handler1);
    bind(target2 as unknown as EventTarget, 'change', handler2);

    const [, registered1] = target1.addEventListener.mock.calls[0] as [string, EventListener];
    const [, registered2] = target2.addEventListener.mock.calls[0] as [string, EventListener];

    expect(cleanups).toHaveLength(2);

    // Clean up in order
    cleanups[0]?.();
    expect(target1.removeEventListener).toHaveBeenCalledWith('click', registered1);
    expect(target2.removeEventListener).not.toHaveBeenCalled();

    cleanups[1]?.();
    expect(target2.removeEventListener).toHaveBeenCalledWith('change', registered2);
  });

  it('supports the full cleanup-all pattern used by consumers', () => {
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);
    const targets = Array.from({ length: 5 }, () => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));

    targets.forEach((t) => {
      bind(t as unknown as EventTarget, 'click', vi.fn());
    });

    expect(cleanups).toHaveLength(5);

    // Splice-and-run pattern used by consumer cleanup functions
    const batch = cleanups.splice(0, cleanups.length);
    batch.forEach(fn => fn());

    expect(cleanups).toHaveLength(0);
    targets.forEach(t => {
      expect(t.removeEventListener).toHaveBeenCalledOnce();
    });
  });

  it('works with EventListenerObject (handleEvent pattern)', () => {
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const listenerObj = { handleEvent: vi.fn() };

    bind(target as unknown as EventTarget, 'click', listenerObj);

    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    const [type, registered] = target.addEventListener.mock.calls[0] as [string, EventListener];
    expect(type).toBe('click');

    // Invoking the wrapped listener must delegate to handleEvent.
    const event = new Event('click');
    registered(event);
    expect(listenerObj.handleEvent).toHaveBeenCalledWith(event);

    cleanups[0]?.();
    expect(target.removeEventListener).toHaveBeenCalledWith('click', registered);
  });

  it('different binders share the same cleanup array', () => {
    const sharedCleanups: Array<() => void> = [];
    const bind1 = createEventBinder(sharedCleanups);
    const bind2 = createEventBinder(sharedCleanups);
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };

    bind1(target as unknown as EventTarget, 'click', vi.fn());
    bind2(target as unknown as EventTarget, 'input', vi.fn());

    expect(sharedCleanups).toHaveLength(2);
  });

  it('separate binders with separate arrays are independent', () => {
    const cleanups1: Array<() => void> = [];
    const cleanups2: Array<() => void> = [];
    const bind1 = createEventBinder(cleanups1);
    const bind2 = createEventBinder(cleanups2);
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };

    bind1(target as unknown as EventTarget, 'click', vi.fn());
    bind2(target as unknown as EventTarget, 'input', vi.fn());

    expect(cleanups1).toHaveLength(1);
    expect(cleanups2).toHaveLength(1);
  });
});
