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