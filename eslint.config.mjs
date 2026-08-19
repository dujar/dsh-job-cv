// Flat-config ESLint for both halves of the plugin. The client fragments
// are fragments of one IIFE scope (functions used across files), so the two
// IIFE-boundary fragments are simply excluded; the middle fragments are
// linted as scripts with cross-file names allowed.
import js from '@eslint/js'

export default [
  { ignores: ['node_modules/**', 'lib/client/010-preamble.js', 'lib/client/060-plugin-wiring.js'] },
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
      // `var` hoists, so a read above its declaration yields undefined rather
      // than throwing — and `undefined !== null` is true, which is how the
      // preview came to believe it was showing a version it did not have.
      // Function declarations hoist by design here: the client fragments are
      // one shared scope and call across each other freely.
      'no-use-before-define': [
        'error',
        { functions: false, classes: false, variables: true, allowNamedExports: true },
      ],
    },
  },
  {
    // The BUILT bundle is the one place the fragments become a single scope,
    // so it is the only place no-undef can see a name that is used but never
    // defined anywhere — the failure mode of editing fragments in isolation
    // (a rewrite once truncated CommentPanel, and nothing noticed until the
    // dock crashed on click).
    files: ['lib/client.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        EventSource: 'readonly',
        FileReader: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        getComputedStyle: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
      'no-use-before-define': 'off', // one hoisted scope by construction
    },
  },
  {
    files: ['lib/client/*.js'],
    languageOptions: { sourceType: 'script' },
    rules: {
      // fragments share one IIFE scope: names defined in 010, used in 050
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-use-before-define': [
        'error',
        { functions: false, classes: false, variables: true, allowNamedExports: true },
      ],
    },
  },
]
