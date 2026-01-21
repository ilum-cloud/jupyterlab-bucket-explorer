const jestJupyterLab = require('@jupyterlab/testutils/lib/jest-config');

const esModules = [
  '@jupyterlab/',
  '@jupyter/',
  '@microsoft/fast',
  'exenv\\-es6',
  'lib0',
  'y\\-protocols',
  'y\\-websocket',
  'yjs'
].join('|');

const jlabConfig = jestJupyterLab(__dirname);

const {
  moduleFileExtensions,
  moduleNameMapper,
  preset,
  setupFilesAfterEnv,
  setupFiles,
  testPathIgnorePatterns,
  transform
} = jlabConfig;

module.exports = {
  moduleFileExtensions,
  moduleNameMapper,
  preset,
  setupFilesAfterEnv: [
    ...(setupFilesAfterEnv || []),
    '<rootDir>/src/__tests__/jest.setup.ts'
  ],
  setupFiles,
  testPathIgnorePatterns,
  modulePathIgnorePatterns: [
    'jupyterlab_bucket_explorer/labextension/',
    '<rootDir>/.venv/',
    '/node_modules/.*/staging/'
  ],
  transform: {
    ...transform,
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Use test-specific TS config to include Node/Jest typings
        tsconfig: 'tsconfig.test.json'
      }
    ]
  },
  testEnvironment: 'jsdom',
  automock: false,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/.ipynb_checkpoints/*'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text'],
  testRegex: 'src/.*/.*.spec.ts[x]?$',
  transformIgnorePatterns: [`/node_modules/(?!${esModules}).+`]
};
