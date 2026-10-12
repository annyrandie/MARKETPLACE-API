// Спільна база для всіх трьох test-костюмів (integration/e2e/contract).
// Жоден з наших тестових файлів не TypeScript — transform: {} означає "не
// трансформувати нічого", тести запускаються як звичайний Node CommonJS.
//
// Без рядка `reporters` Jest 30 сам вибирає репортер — за змінними
// оточення (detectAgent() у @jest/core) — і в частині середовищ це вмикає
// компактний репортер 'agent': той не друкує ні `PASS <файл>`, ні назв
// describe/it, ні ✓ — лишається тільки підсумок `Tests: N passed`.
// Явний класичний репортер робить вивід однаковим скрізь, незалежно від
// того, де саме запускають цю роботу (той самий рядок, що й у
// jest.config.js лекцій 10 і 16).
module.exports = {
  testEnvironment: 'node',
  transform: {},
  reporters: ['default'],
  maxWorkers: 1,
  verbose: true,
};
