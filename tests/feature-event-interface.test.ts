import { afterEach, describe, expect, it } from 'vitest';

import { emit, on } from '../js/modules/core/event-bus.js';
import { requestFeature } from '../js/modules/core/feature-event-interface.js';

describe('feature-event-interface', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('keeps concurrent feature requests isolated by response event', async () => {
    cleanup = on(
      'feature:request:test-concurrency',
      (data: { payload?: { value?: number; delayMs?: number }; responseEvent?: string }) => {
        const responseEvent = data.responseEvent;
        const value = data.payload?.value ?? 0;
        const delayMs = data.payload?.delayMs ?? 0;

        if (!responseEvent) {
          return;
        }

        setTimeout(() => {
          emit(responseEvent, {
            type: 'feature:request:test-concurrency',
            result: value
          });
        }, delayMs);
      }
    );

    const slowRequest = requestFeature<number>('feature:request:test-concurrency', {
      value: 1,
      delayMs: 20
    });
    const fastRequest = requestFeature<number>('feature:request:test-concurrency', {
      value: 2,
      delayMs: 0
    });

    await expect(Promise.all([slowRequest, fastRequest])).resolves.toEqual([1, 2]);
  });
});
