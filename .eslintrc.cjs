// ESLint config (legacy / eslintrc — ESLint 8). Run via `npm run lint`
// (`eslint --ext .ts,.tsx .`). Tuned to be useful without drowning the
// existing codebase: real-bug rules error, style/strictness are warnings
// or off so the signal stays high.
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: 'detect' } },
  ignorePatterns: [
    'node_modules',
    'dist',
    '.vite',
    'out',
    'build',
    'vendor',
    'site',
    'scripts',
    '*.config.ts',
    '*.config.js',
  ],
  rules: {
    // React 19 / automatic JSX runtime — no need to import React in scope.
    'react/react-in-jsx-scope': 'off',
    'react/jsx-uses-react': 'off',
    // TypeScript owns prop typing; apostrophes in copy are fine.
    'react/prop-types': 'off',
    'react/no-unescaped-entities': 'off',
    // Hooks: missing-dep is the real-bug rule — keep it as a warning so it
    // surfaces without blocking; rules-of-hooks stays an error (recommended).
    'react-hooks/exhaustive-deps': 'warn',
    // Unused vars as warnings, with the conventional underscore opt-out.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    // The codebase deliberately uses `any` and ts pragmas in a few spots.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    // Terminal/ANSI handling legitimately matches control characters
    // (escape sequences, scrollback sanitisation).
    'no-control-regex': 'off',
    // Electron's <webview> tag carries non-DOM attributes (partition,
    // allowpopups) that React's HTML-attribute checker doesn't know.
    'react/no-unknown-property': 'off',
    // A few dynamic `require()`s for conditionally-loaded native modules.
    '@typescript-eslint/no-var-requires': 'off',
    // `while (true)` watch/poll loops are intentional.
    'no-constant-condition': ['error', { checkLoops: false }],
    // Non-null assertions are used deliberately in a few hot paths.
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
};
