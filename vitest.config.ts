import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', environmentOptions: { jsdom: { url: 'http://127.0.0.1/' } }, setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], restoreMocks: true, clearMocks: true, maxWorkers: 1 } });
