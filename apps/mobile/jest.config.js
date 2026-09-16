/**
 * Jest for the app's views.
 *
 * The app ships as a web build, but the components still carry `Platform.OS`
 * guards — keyboard shortcuts and the rating buttons' number prefix are behind
 * `=== 'web'`, and a few fall-through branches are not. Two projects, one under
 * each of jest-expo's platform presets, exercise both sides of those guards
 * rather than mocking `Platform` and testing the mock.
 *
 * `transformIgnorePatterns` has to reach the workspace root: @fluentflow/core
 * and every expo package ship untranspiled ESM, and they resolve above this
 * directory in a monorepo.
 */

const transformIgnorePatterns = [
  'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?'
    + '|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*'
    + '|@sentry/react-native|native-base|react-native-svg|@fluentflow/.*))',
];

const shared = {
  rootDir: __dirname,
  setupFilesAfterEnv: ['<rootDir>/test/setup.tsx'],
  transformIgnorePatterns,
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  // Expo's first transforms are expensive. Bound parallelism so cold installs
  // do not spend the first view test's timeout competing for CPU and memory.
  maxWorkers: 2,
  projects: [
    {
      ...shared,
      displayName: 'native',
      preset: 'jest-expo/ios',
      testMatch: ['<rootDir>/test/**/*.test.ts', '<rootDir>/test/**/*.test.tsx'],
      testPathIgnorePatterns: ['\.web\.test\.tsx?$'],
    },
    {
      ...shared,
      displayName: 'web',
      preset: 'jest-expo/web',
      testMatch: ['<rootDir>/test/**/*.web.test.ts', '<rootDir>/test/**/*.web.test.tsx'],
    },
  ],
};
