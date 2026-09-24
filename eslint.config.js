// ESLint flat config: the TypeScript under src/, bin/ and test/, and the
// console's plain browser modules. templates/demo-site is its own Next.js
// project with its own lint setup, so it is left out here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/', 'dist/', 'data/', '.pipeline-fixture/',
      'templates/demo-site/', 'apps-script/', 'bin/__pycache__/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['console/js/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'module' },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
