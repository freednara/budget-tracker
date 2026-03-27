import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupLazyLoading, initLazyLoading } from '../js/modules/core/lazy-loader.js';

describe('lazy-loader lifecycle', () => {
  let observerCreateCount = 0;

  beforeEach(() => {
    observerCreateCount = 0;
    document.body.innerHTML = '';

    class MockIntersectionObserver {
      constructor() {
        observerCreateCount++;
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  afterEach(() => {
    cleanupLazyLoading();
    vi.unstubAllGlobals();
  });

  it('can be cleaned up and initialized again', () => {
    initLazyLoading();
    cleanupLazyLoading();
    initLazyLoading();

    expect(observerCreateCount).toBe(2);
  });
});
