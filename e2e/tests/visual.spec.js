// @ts-check
const { test, expect } = require('@playwright/test')

/**
 * Visual regression over the design system.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Screenshots the Storybook stories in `frontend/src/components/ui/ui.stories.jsx`
 * and diffs them against committed baselines, in BOTH themes.
 *
 * ── Why Storybook and not the running app ──
 *
 * A screenshot test is only useful if the same input produces the same pixels.
 * The app's pages render live balances, open positions and timestamps, so
 * screenshotting them reports a diff on every run for reasons that have nothing
 * to do with design, and a test that always fails gets muted within a week.
 * Stories render fixed content with no backend at all.
 *
 * ── Why the container matters ──
 *
 * Font rasterisation differs between Windows, macOS and Linux, and between
 * Linux distributions. Baselines generated on a developer's machine will not
 * match a CI runner's, and the resulting permanent red is the single most
 * common reason screenshot suites get deleted.
 *
 * So these only run inside the pinned Playwright image, matching the version in
 * package.json exactly:
 *
 *     docker run --rm -v "$PWD:/work" -w /work \
 *       mcr.microsoft.com/playwright:v1.62.1-noble \
 *       npx playwright test visual --update-snapshots
 *
 * Outside that image the project is skipped rather than run with baselines it
 * cannot reproduce -- a skip is honest, a red build for an environment reason is
 * noise that trains people to ignore the suite.
 */

const STORIES = [
  'design-system-primitives--buttons',
  'design-system-primitives--cards',
  'design-system-primitives--badges',
  'design-system-primitives--stats',
  'design-system-primitives--progress',
  'design-system-primitives--skeletons',
  'design-system-primitives--everything'
]

const THEMES = ['dark', 'light']

// Set by the CI job and by the docker command above. Absent locally on Windows
// or macOS, where the baselines cannot be reproduced.
const PINNED = process.env.PLAYWRIGHT_PINNED_IMAGE === '1'

test.describe('@visual design system', () => {
  test.skip(!PINNED,
    'Visual baselines are only reproducible inside the pinned Playwright image. ' +
    'Set PLAYWRIGHT_PINNED_IMAGE=1 when running there.')

  for (const story of STORIES) {
    for (const theme of THEMES) {
      test(`${story} — ${theme}`, async ({ page }) => {
        await page.goto(`/iframe.html?id=${story}&globals=theme:${theme}&viewMode=story`)

        // Storybook mounts asynchronously; waiting for the root to have content
        // is more reliable than a fixed delay and does not slow the suite down
        // on a fast machine.
        await page.waitForSelector('#storybook-root > *', { timeout: 15_000 })

        // The skeleton shimmer is a running animation. Left alone it lands at a
        // different frame on every run and every skeleton screenshot differs by
        // a few pixels of gradient -- a real diff, of nothing.
        await page.addStyleTag({
          content: `*, *::before, *::after {
            animation: none !important;
            transition: none !important;
          }`
        })

        // Web fonts must be resolved before the shot. Playfair and Source Serif
        // arrive over the network, and a screenshot taken mid-swap captures the
        // fallback serif at different metrics.
        await page.evaluate(() => document.fonts.ready)

        await expect(page).toHaveScreenshot(`${story}-${theme}.png`, {
          fullPage: true,
          // A couple of pixels of antialiasing on a curve is not a regression.
          // Anything that actually moved a box will exceed this comfortably.
          maxDiffPixelRatio: 0.01,
          animations: 'disabled'
        })
      })
    }
  }
})
