/**
 * Shared Event Binding Utility
 *
 * Creates a scoped event binder that automatically tracks listeners for cleanup.
 * Eliminates duplication of the bind-and-push-cleanup pattern used across
 * modal-events, filter-events, pin-ui-handlers, debt-ui-handlers, and
 * budget-planner-ui modules.
 *
 * ## Async handlers
 *
 * The binder accepts both synchronous and async handlers. When an async
 * handler is passed, the binder wraps it so the returned promise's rejection
 * is caught and routed through `trackError` rather than becoming an
 * unhandled rejection (which the browser surfaces on `window.onerror`
 * but loses the call-site context).
 *
 * This lets call sites write `bind(btn, 'click', async () => {...})`
 * without triggering `@typescript-eslint/no-misused-promises`, because
 * the handler parameter type explicitly includes `Promise<void>` in its
 * return-union.
 *
 * @module event-binding
 */
import { trackError } from './error-tracker.js';

/**
 * A handler that may be sync or async. Async handlers are wrapped so
 * their rejections are caught and routed through `trackError`.
 */
export type AsyncEventHandler =
  | EventListenerOrEventListenerObject
  | ((event: Event) => void | Promise<void>);

/**
 * Create a scoped event binder tied to a cleanup array.
 *
 * Usage:
 * ```ts
 * const cleanups: Array<() => void> = [];
 * const bind = createEventBinder(cleanups);
 *
 * bind(button, 'click', handleClick);
 * bind(input, 'input', handleInput);
 *
 * // Later, to remove all listeners:
 * cleanups.forEach(fn => fn());
 * cleanups.length = 0;
 * ```
 */
export function createEventBinder(
  cleanups: Array<() => void>
): (target: EventTarget, type: string, handler: AsyncEventHandler) => void {
  return (target, type, handler) => {
    // Wrap so async handler rejections are captured via trackError
    // instead of becoming unhandled promise rejections.
    const wrapped: EventListener = (event) => {
      let result: unknown;
      if (typeof handler === 'function') {
        result = handler(event);
      } else {
        // EventListenerObject form
        result = handler.handleEvent(event);
      }
      // CR-Apr24-I finding 342: also catch generic thenables, not just
      // native Promises, so async rejections from polyfilled or
      // library-provided promise-likes are routed through trackError.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- thenable duck-typing
      if (result != null && typeof (result as any).catch === 'function') {
        (result as Promise<unknown>).catch((err: unknown) => {
          const errObj = err instanceof Error ? err : new Error(String(err));
          trackError(errObj, {
            module: 'event-binding',
            action: `event_handler_${type}`,
          });
        });
      }
    };
    target.addEventListener(type, wrapped);
    cleanups.push(() => {
      target.removeEventListener(type, wrapped);
    });
  };
}
