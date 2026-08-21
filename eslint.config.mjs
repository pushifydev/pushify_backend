import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config (ESLint 9). The backend had no config file at all, so `npm run lint` never ran —
 * this is deliberately the non-type-checked preset so it stays fast enough to run on every commit;
 * `npm run typecheck` already covers what the type-aware rules would.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/db/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        structuredClone: 'readonly',
        __dirname: 'readonly',
        NodeJS: 'readonly',
      },
    },
    rules: {
      // An unused argument is often deliberate (middleware signatures, catch bindings).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Swallowing a failure while shutting down is intentional, not an oversight.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Input sanitisation matches control characters on purpose — that is the point of it.
      'no-control-regex': 'off',
      // A warning, not an error: the existing deploy and worker code uses `any` as a deliberate
      // escape hatch in ~28 places. Keeping the gate green means new ones still get flagged
      // without a sweep that would touch code nothing else in this change touches.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
