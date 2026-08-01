/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: { module: 'ESNext' } }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/index.ts'],
  // The state-machine engine and deadline calculator are the product. Hold them high.
  coverageThreshold: {
    'src/deadlines/': { statements: 90, branches: 85, functions: 90, lines: 90 },
    'src/workflow/': { statements: 90, branches: 85, functions: 90, lines: 90 },
  },
}
