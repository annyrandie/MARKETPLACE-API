// Кожен тестовий файл піднімає свій testcontainer Postgres — 120с на старт
// контейнера + міграції з запасом, maxWorkers: 1 з тієї ж причини, що й у
// лекції: кожен jest-воркер множить контейнери, а не прискорює прогін.
module.exports = {
  ...require('./jest.config.js'),
  testMatch: ['<rootDir>/test/integration/**/*.test.js'],
  testTimeout: 120000,
};
