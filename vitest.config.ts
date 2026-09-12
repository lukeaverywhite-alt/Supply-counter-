import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('0.1.0') },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage-stage3a',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/test/**', 'src/**/*.test.tsx', 'src/types.ts'],
      thresholds: {
        statements: 65,
        branches: 65,
        functions: 65,
        lines: 65,
      },
    },
  },
})
