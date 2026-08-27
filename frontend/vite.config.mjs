/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Emits `build/sw.js` from `sw-template.js` with the real asset list injected.
 *
 * Hand-rolled rather than vite-plugin-pwa/workbox on purpose. The caching
 * policy this app can safely have is "the shell, nothing else" -- see the header
 * of sw-template.js for why an API response must never be cached here -- and
 * that is about sixty lines. Pulling workbox's dependency tree to express a
 * policy narrower than its defaults would add supply-chain surface to a
 * money-handling frontend in exchange for features we specifically must not use.
 *
 * Runs only on build. In dev there is no hashed output to precache and a
 * service worker holding onto modules actively fights HMR.
 */
function offlineShellPlugin() {
  return {
    name: 'propfirm-offline-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const templatePath = path.join(HERE, 'sw-template.js');
      const template = fs.readFileSync(templatePath, 'utf8');

      // Fonts and images are NOT precached: they are fetched on demand and
      // cached by the runtime handler if they turn out to be used. Precaching
      // every one would make a first visit pay for assets a given page never
      // touches, which on a phone is the opposite of the goal.
      const assets = Object.keys(bundle)
        .filter((file) => /\.(js|css)$/.test(file))
        .map((file) => '/' + file);

      const manifest = ['/index.html', '/manifest.json', ...assets];

      const source = template
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(manifest, null, 2))
        .replace('__BUILD_ID__', String(Date.now()));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    }
  };
}


/**
 * Build-time SEO: absolute social images, a canonical origin, and a sitemap.
 *
 * Three defects, one cause — the public domain is not known at build time, so
 * everything that needs an absolute URL was either relative or absent:
 *
 *   - og:image / twitter:image were "/logo512.png". Most scrapers will not
 *     resolve a relative image, so every shared link had a broken preview.
 *   - No <link rel="canonical"> at all.
 *   - No sitemap.xml anywhere in the repo.
 *
 * VITE_PUBLIC_ORIGIN supplies the domain. When it is set, all three are filled
 * in. When it is NOT set, the build still succeeds and simply omits them —
 * exactly the previous behaviour — because a wrong canonical is considerably
 * worse than a missing one, and a sitemap of relative URLs is invalid.
 */
function seoPlugin(publicOrigin) {
  const origin = String(publicOrigin || '').trim().replace(/\/+$/, '');

  return {
    name: 'propfirm-seo',
    transformIndexHtml(html) {
      if (!origin) {
        return html.replace(
          '<meta name="site-origin" content="" />',
          '<!-- VITE_PUBLIC_ORIGIN unset: canonical and absolute social images omitted -->'
        );
      }
      return html
        .replace('<meta name="site-origin" content="" />',
          `<meta name="site-origin" content="${origin}" />\n    <link rel="canonical" href="${origin}/" />`)
        .replace(/(<meta property="og:image" content=")\//, `$1${origin}/`)
        .replace(/(<meta name="twitter:image" content=")\//, `$1${origin}/`)
        .replace(/(<meta property="og:url" content=")\//, `$1${origin}/`);
    },
    async generateBundle() {
      if (!origin) {
        this.warn('VITE_PUBLIC_ORIGIN is not set — skipping sitemap.xml. Set it to emit one.');
        return;
      }

      // Imported at build time so the sitemap and the in-app <title> tags can
      // never list different pages.
      const routesUrl = new URL('./src/config/publicRoutes.js', import.meta.url);
      const { PUBLIC_ROUTES } = await import(routesUrl.href);
      const today = new Date().toISOString().slice(0, 10);

      const urls = PUBLIC_ROUTES.map((route) => [
        '  <url>',
        `    <loc>${origin}${route.path === '/' ? '/' : route.path}</loc>`,
        `    <lastmod>${today}</lastmod>`,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority}</priority>`,
        '  </url>'
      ].join('\n')).join('\n');

      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
      });

      // robots.txt ships a static Sitemap: line pointing at /sitemap.xml, which
      // is origin-relative and therefore correct without substitution.
    }
  };
}

// Note: this file is .mjs deliberately. package.json has no "type": "module",
// so a .js config would be loaded as CommonJS and Vite 8's native config loader
// rejects the ESM syntax below.

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  plugins: [react(), offlineShellPlugin(), seoPlugin(process.env.VITE_PUBLIC_ORIGIN)],
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
  // `vite preview` serves the production build, and it does NOT inherit
  // server.proxy. Without this block a preview build has no API at all, so the
  // only way to point it at a backend would be VITE_API_URL -- a cross-origin
  // value, which index.html's CSP deliberately has no exception for, precisely
  // because config/apiBase.js defaults to same-origin so dev and prod resolve
  // identically. Mirroring the proxy keeps the preview same-origin like both.
  //
  // This is what the `a11y` CI job serves the app from: axe has to run against
  // the real build, not the dev server.
  preview: {
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
          // NB: `node_modules/react` is a SUBSTRING test, so this also claims
          // react-chartjs-2, react-countup and react-hot-toast -- every
          // `react-*` package, not just the three named. That is why splitting
          // chart.js out below moved ~172KB off the entry path rather than the
          // ~6KB the wrapper alone weighs: react-chartjs-2 was landing in
          // `vendor`, which every page loads, and dragging chart.js in with it.
          // The remaining sweep is small and app-wide, so it is left alone --
          // but it is accidental, not designed.
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router-dom')) {
            return 'vendor';
          }
          if (id.includes('node_modules/recharts')) {
            return 'charts';
          }
          // There was a `chartsLegacy` rule here for chart.js + react-chartjs-2,
          // which served exactly one page (Transparency.jsx) while recharts
          // served the other sixteen. Transparency is on recharts now and both
          // packages are uninstalled, so the rule went with them -- the same
          // housekeeping `lightweight-charts` needed, whose rule outlived the
          // dependency and spent a year chunking something nothing imported.
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