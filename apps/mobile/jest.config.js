/**
 * Jest for the React Native views.
 *
 * Two projects rather than one, because `Platform.OS` is not a detail these
 * screens can be tested around: keyboard shortcuts only bind on web, and the
 * rating buttons render their number prefix only on web. Mocking `Platform`
 * would test the mock. Running the same components under both of jest-expo's
 * platform presets tests the real branch.
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
