import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import prettier from 'eslint-config-prettier';

/**
 * Platform boundary (doc 02 §1, CLAUDE.md).
 *
 * Nothing outside packages/app/src/platform may reference OPFS, WebAuthn,
 * Web Push or Capacitor directly. That rule is what makes the native phases an
 * adapter swap instead of a rewrite, so it is enforced rather than documented.
 */
const restrictedPlatformImports = [
  {
    group: ['@capacitor/*', '@capacitor-community/*'],
    message:
      'Capacitor may only be used inside packages/app/src/platform. Go through the Storage / SecureStore / Push adapters.',
  },
  {
    group: ['@sqlite.org/sqlite-wasm'],
    message:
      'SQLite-WASM may only be used inside packages/app/src/platform/web. Go through the Storage adapter.',
  },
];

const restrictedPlatformSyntax = [
  {
    selector: "MemberExpression[property.name='getDirectory']",
    message:
      'OPFS (navigator.storage.getDirectory) may only be used inside packages/app/src/platform/web. Go through the Storage adapter.',
  },
  {
    selector: "MemberExpression[object.name='navigator'][property.name='credentials']",
    message:
      'WebAuthn (navigator.credentials) may only be used inside packages/app/src/platform/web. Go through the SecureStore adapter.',
  },
  {
    selector: "Identifier[name='PublicKeyCredential']",
    message:
      'WebAuthn may only be used inside packages/app/src/platform/web. Go through the SecureStore adapter.',
  },
  {
    selector: "MemberExpression[property.name='pushManager']",
    message:
      'Web Push may only be used inside packages/app/src/platform/web. Go through the Push adapter.',
  },
  {
    selector: "Identifier[name='Capacitor']",
    message:
      'Capacitor may only be used inside packages/app/src/platform. Go through the platform adapters.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/api/drizzle/**',
      'packages/app/dev-dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
    rules: {
      // Single-word view names are fine, this is not a component library.
      'vue/multi-word-component-names': 'off',
    },
  },

  {
    files: ['packages/app/src/**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        // Replaced at build time by Vite, declared in src/env.d.ts.
        __APP_VERSION__: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': ['error', { patterns: restrictedPlatformImports }],
      'no-restricted-syntax': ['error', ...restrictedPlatformSyntax],
    },
  },

  {
    // The adapters are the one place allowed to touch the platform directly.
    files: ['packages/app/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  {
    files: ['packages/api/**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
      },
    },
  },

  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Build-time scripts run in Node and report what they produced, which is
    // the whole point of running one by hand.
    files: ['packages/*/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Last, so Prettier owns formatting and ESLint owns correctness.
  prettier,
);
