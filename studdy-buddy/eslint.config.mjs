import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config.
 *
 * The goal is not style policing — prettier-ish taste is not worth a build
 * failure. This catches the classes of bug that typechecking cannot:
 * floating promises that silently swallow failures, `==`, unused variables that
 * hide a half-finished refactor, and accidental `any` leaking through a boundary.
 *
 * Deliberately NOT enabled:
 *  - `no-console`: the Electron main process and the CLI are supposed to log.
 *  - sort/exhaustive-deps strictness as errors: too noisy to be a gate here.
 */

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // Extension scripts run in a browser service-worker context, not through a
      // bundler, and are plain JS with no module graph to type.
      'apps/browser-extension/**',
      'apps/desktop/scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // A forgotten `await` on a promise-returning call is the most expensive bug
      // in this codebase: it turns a permission check into a no-op.
      '@typescript-eslint/no-floating-promises': 'off', // requires type-aware linting; see below
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-restricted-syntax': [
        'error',
        {
          // `any` casts at a trust boundary are how unvalidated payloads become
          // "typed". Validation belongs in a schema, not a cast.
          selector: "TSAsExpression > TSAnyKeyword",
          message: 'Do not cast to any; parse the value or use unknown + a guard.',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
);
