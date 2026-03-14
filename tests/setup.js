// Test setup - mocks for browser APIs
import { beforeEach, vi } from 'vitest';

// Mock localStorage
const localStorageStore = {};
const localStorageMock = {
  getItem: (key) => localStorageStore[key] ?? null,
  setItem: (key, value) => { localStorageStore[key] = String(value); },
  removeItem: (key) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
  get length() { return Object.keys(localStorageStore).length; },
  key: (i) => Object.keys(localStorageStore)[i] ?? null
};

// Use vi.stubGlobal for proper mocking
vi.stubGlobal('localStorage', localStorageMock);

// Reset state before each test
beforeEach(() => {
  localStorageMock.clear();
});

// Export for use in tests
export { localStorageMock, localStorageStore };
