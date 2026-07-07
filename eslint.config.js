import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'bin/**',
      'dist/**',
      'web/**',
      'demo/**',
      '.claude/**',
      '.agents/**',
      'docs/**'
    ]
  }
];
