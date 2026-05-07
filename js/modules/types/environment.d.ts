/**
 * Environment Type Definitions
 * Provides TypeScript types for environment variables and build-time constants
 */

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production' | 'test';
      [key: string]: string | undefined;
    }
  }

  // NOTE: `interface Window { ... }` augmentation has been centralized in
  // `js/types/globals.d.ts` (Phase 6 Slice 1a, Inline-Behavior-Review L1).
  // Do not add Window properties here — add them to globals.d.ts so the
  // startup-progress, debug-toggle, ready-state, deferred-error, test-mode,
  // and integration-point surfaces have a single source of truth.

  interface ImportMeta {
    env: {
      MODE: 'development' | 'production';
      PROD: boolean;
      DEV: boolean;
      SSR: boolean;
      BASE_URL: string;
      [key: string]: any;
    };
    hot?: {
      accept: (cb?: () => void) => void;
      dispose: (cb: () => void) => void;
      invalidate: () => void;
      decline: () => void;
      on: (event: string, cb: (...args: any[]) => void) => void;
    };
  }

  const process: {
    env: NodeJS.ProcessEnv;
  };
}

export {};