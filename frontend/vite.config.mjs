/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Note: this file is .mjs deliberately. package.json has no "type": "module",
// so a .js config would be loaded as CommonJS and Vite 8's native config loader
// rejects the ESM syntax below.

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'build',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router-dom')) {
            return 'vendor';
          }
          if (id.includes('node_modules/recharts')) {
            return 'charts';
          }
          if (id.includes('node_modules/lightweight-charts')) {
            return 'tradingCharts';
          }
          if (id.includes('node_modules/framer-motion')) {
            return 'motion';
          }
          if (id.includes('node_modules/zustand')) {
            return 'store';
          }
        }
      }
    }
  },
  // ── Test config ──────────────────────────────────────────────────────────
  // `storybook init` also added a second vitest project that renders every
  // story in a real headless Chromium via @storybook/addon-vitest. It was
  // removed rather than kept, for one reason: browser mode needs Playwright
  // browser binaries, so the frontend CI job would have to download a browser
  // on every run to smoke-test stories that the `visual` job already renders and
  // screenshots inside the pinned Playwright image.
  //
  // Paying a browser download on every CI run for coverage that already exists
  // elsewhere is how a test suite gets slow enough that people stop running it.
  // A story that throws still fails CI -- it fails in `visual`, where a browser
  // is already present.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.js',
    css: true
  }
});