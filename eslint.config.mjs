// Flat-config ESLint for both halves of the plugin. The client fragments
// are fragments of one IIFE scope (functions used across files), so the two
// IIFE-boundary fragments are simply excluded; the middle fragments are
// linted as scripts with cross-file names allowed.
import js from '@eslint/js'

export default [
  { ignores: ['node_modules/**', 'lib/client.js', 'lib/client/010-preamble.js', 'lib/client/060-plugin-wiring.js'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        getComputedStyle: 'readonly',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: ['lib/client/*.js'],
    languageOptions: { sourceType: 'script' },
    rules: {
      // fragments share one IIFE scope: names defined in 010, used in 050
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
]
