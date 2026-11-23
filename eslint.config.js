import javascript from '@eslint/js';
import typescript from 'typescript-eslint';
import house from './tools/eslint-plugin-house/index.js';

const PROCESS_ENV_RESTRICTION = {
  object: 'process',
  property: 'env',
  message: 'Read configuration from the config object. Only src/config.ts reads process.env.',
};

const DATE_NOW_RESTRICTION = {
  object: 'Date',
  property: 'now',
  message: 'Take the time from the injected clock (src/lookup/clock.ts) so output stays deterministic.',
};

const NEW_DATE_RESTRICTION = {
  selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
  message: 'Take the time from the injected clock (src/lookup/clock.ts) so output stays deterministic.',
};

const NETWORK_MODULES = ['http', 'https', 'net', 'dns', 'tls'];

export default typescript.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  javascript.configs.recommended,
  ...typescript.configs.recommended,
  {
    plugins: { house },
    rules: {
      'id-length': ['error', { min: 2, properties: 'never' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'house/no-swallowed-catch': 'error',
      'house/no-return-in-loop': 'error',
      'house/no-foreach-return': 'error',
      'no-restricted-properties': ['error', PROCESS_ENV_RESTRICTION],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^unused' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', PROCESS_ENV_RESTRICTION, DATE_NOW_RESTRICTION],
      'no-restricted-syntax': ['error', NEW_DATE_RESTRICTION],
      'no-restricted-imports': ['error', {
        paths: NETWORK_MODULES.flatMap((moduleName) => [moduleName, `node:${moduleName}`]).map((name) => ({
          name,
          message: 'Network access goes through the guarded client in src/net/.',
        })),
      }],
    },
  },
  {
    files: ['src/config.ts'],
    rules: { 'no-restricted-properties': ['error', DATE_NOW_RESTRICTION] },
  },
  {
    files: ['src/logger.ts', 'src/lookup/clock.ts'],
    rules: {
      'no-restricted-properties': ['error', PROCESS_ENV_RESTRICTION],
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['src/net/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
