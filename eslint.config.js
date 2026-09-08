/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-constant-condition': 'error',
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
    },
  },
];
