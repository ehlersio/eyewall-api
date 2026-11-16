import js from '@eslint/js';

const workerGlobals = {
  fetch: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly',
  URL: 'readonly', console: 'readonly', crypto: 'readonly', caches: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly',
};

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: workerGlobals },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
    },
  },
  {
    files: ['scripts/**', 'test/**'],
    languageOptions: { globals: { ...workerGlobals, process: 'readonly' } },
  },
  { ignores: ['node_modules/', '.wrangler/', 'dist/'] },
];
