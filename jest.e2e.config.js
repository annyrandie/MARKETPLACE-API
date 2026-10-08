module.exports = {
  ...require('./jest.config.js'),
  testMatch: ['<rootDir>/test/e2e/**/*.test.js'],
  testTimeout: 60000,
};
