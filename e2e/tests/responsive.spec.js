// @ts-check
const { test, expect } = require('@playwright/test')
const { testViewports } = require('../../frontend/scripts/lib/viewports.js')

/**
 * Viewport matrix over the responsive surfaces.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Runs against the Storybook build, the same one the @visual project uses and
 * that CI already builds and serves on :6006.
 *
 * ── Why Storybook and not the app ──
 *
 * The app's pages render live balances, open positions and timestamps, so a
 * layout measurement taken against them depends on how many rows the seed
 * account happens to hold. Stories render fixed content and hit no backend, so
 * a failure here means the CSS changed and nothing else.
 *
 * ── Why this does NOT need the pinned container, unlike @visual ──
 *
 * @visual compares pixels, so it is hostage to font rasterisation and is
 * skipped outside the pinned image. These assertions are geometric --
 * scrollWidth against clientWidth, bounding boxes against a token -- and those
 * do not change between a Linux runner and a developer's Windows machine. So
 * this project runs everywhere, which is the point: a check that only runs in
 * CI is one people discover they have broken at the worst moment.
 *
 * ── The device list is not written here ──
 *
 * It is read from frontend/src/styles/breakpoints.js through the same helper
 * `scripts/responsive-drift.js` uses. The static counter and these browser
 * assertions therefore cannot end up disagreeing about which phones matter --
 * the failure mode that made the previous UI brief's numbers unrecomputable.
 */

const STORIES = [
  'responsive-surfaces--admin-table',
  'responsive-surfaces--admin-table-selectable',
  'responsive-surfaces--admin-table-opted-out',
  'responsive-surfaces--trader-table-cards',
  'responsive-surfaces--trader-table-scrolling',
  'responsive-surfaces--forms',
]

const VIEWPORTS = testViewports()

/** WCAG 2.5.5 / platform-HIG minimum, mirroring --touch-min in tokens.css. */
const TOUCH_MIN = 44

/** iOS Safari zooms below this and never zooms back out. */
const MIN_INPUT_FONT = 16

async function openStory(page, story) {
  await page.goto(`/iframe.html?id=${story}&viewMode=story`)
  await page.waitForSelector('#storybook-root > *', { timeout: 15_000 })
  // Web fonts change metrics, and a box measured mid-swap is measured twice.
  await page.evaluate(() => document.fonts && document.fonts.ready)
}

test.describe('@responsive viewport matrix', () => {
  for (const vp of VIEWPORTS) {
    test.describe(`${vp.name} ${vp.width}x${vp.height} — ${vp.label}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } })

      for (const story of STORIES) {
        test(`${story} does not scroll the document sideways`, async ({ page }) => {
          await openStory(page, story)

          const box = await page.evaluate(() => {
            const doc = document.documentElement
            return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
          })

          // The +1 absorbs sub-pixel rounding on fractional device widths; it
          // is not slack for a real overflow, which is always tens of pixels.
          // A wide table is allowed to scroll INSIDE its own container -- that
          // is the fix, not the bug. What must never happen is the page itself
          // scrolling, which is what strands a fixed header and makes every
          // tap land in the wrong place.
          expect(
            box.scrollWidth,
            `document is ${box.scrollWidth}px wide in a ${box.clientWidth}px viewport`
          ).toBeLessThanOrEqual(box.clientWidth + 1)
        })
      }

      // Tap targets and font sizes are only a mobile concern, and only the
      // narrow viewports mount the card layouts under test.
      if (vp.width < 768) {
        test('every visible control clears the minimum tap target', async ({ page }) => {
          await openStory(page, 'responsive-surfaces--forms')

          const undersized = await page.evaluate((min) => {
            const selector = 'button, a[href], input, select, textarea, [role="button"]'
            const bad = []
            for (const el of document.querySelectorAll(selector)) {
              const rect = el.getBoundingClientRect()
              // Zero-size elements are not rendered; a hidden control cannot be
              // mistapped, and flagging it would be noise.
              if (rect.width === 0 || rect.height === 0) continue
              if (el.type === 'hidden') continue
              if (rect.height < min) {
                bad.push(
                  `${el.tagName.toLowerCase()}` +
                  `${el.id ? '#' + el.id : ''} ` +
                  `${Math.round(rect.width)}x${Math.round(rect.height)}`
                )
              }
            }
            return bad
          }, TOUCH_MIN)

          expect(
            undersized,
            `controls under ${TOUCH_MIN}px tall: ${undersized.join(', ')}`
          ).toEqual([])
        })

        test('no form control renders small enough to trigger the iOS zoom', async ({ page }) => {
          await openStory(page, 'responsive-surfaces--forms')

          const tooSmall = await page.evaluate((min) => {
            const bad = []
            for (const el of document.querySelectorAll('input, select, textarea')) {
              const size = parseFloat(getComputedStyle(el).fontSize)
              // Rounded because a 15.98px computed value from a rem is not the
              // defect this is looking for.
              if (Math.round(size) < min) {
                bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} at ${size}px`)
              }
            }
            return bad
          }, MIN_INPUT_FONT)

          expect(
            tooSmall,
            `controls under ${MIN_INPUT_FONT}px: ${tooSmall.join(', ')}`
          ).toEqual([])
        })

        test('the admin table becomes cards rather than staying a table', async ({ page }) => {
          await openStory(page, 'responsive-surfaces--admin-table')

          // The table is gone from the DOM, not merely hidden -- the point of
          // gating on useIsMobile() rather than dual-rendering.
          await expect(page.locator('table.admin-table')).toHaveCount(0)
          await expect(page.locator('.admin-card')).toHaveCount(3)
        })

        test('the opted-out table still scrolls inside its own container', async ({ page }) => {
          await openStory(page, 'responsive-surfaces--admin-table-opted-out')

          const wrapper = page.locator('.admin-table-wrapper')
          await expect(wrapper).toHaveCount(1)

          const scrolls = await wrapper.evaluate((el) => el.scrollWidth > el.clientWidth)
          // If this is ever false the table stopped being wide, which would
          // mean the columns squashed -- the failure the wrapper exists to
          // prevent, and one a page-overflow assertion alone cannot see.
          expect(scrolls, 'wide table should scroll within its wrapper').toBe(true)
        })
      }
    })
  }
})

/**
 * WCAG 1.4.4 Resize Text (AA): content must stay usable at 200% zoom.
 *
 * ── Why halved viewports rather than a zoom API ──
 *
 * Browser page zoom and CSS-pixel viewport size are the same thing to a layout:
 * 1280x960 at 200% zoom gives the page a 640x480 CSS-pixel viewport, which is
 * exactly what setting that viewport produces. Playwright has no page-zoom
 * control, and `deviceScaleFactor` changes rasterisation rather than layout, so
 * it would test nothing here.
 *
 * The failure this catches is a desktop layout that reflows only at its mobile
 * breakpoints: at 640px a min-width'd table or a fixed sidebar pushes the
 * document wider than the viewport, and a low-vision user zoomed to 200% has to
 * scroll horizontally to read every line -- the specific thing 1.4.4 forbids.
 *
 * Reuses the same scrollWidth assertion as the matrix above rather than
 * introducing a second definition of "overflows".
 */
const ZOOM_CASES = [
  { label: '1280x960 desktop at 200%', width: 640, height: 480 },
  { label: '1440x900 laptop at 200%', width: 720, height: 450 },
  { label: '1024x768 tablet landscape at 200%', width: 512, height: 384 },
]

test.describe('@responsive 200% zoom (WCAG 1.4.4)', () => {
  for (const zoom of ZOOM_CASES) {
    test.describe(zoom.label, () => {
      test.use({ viewport: { width: zoom.width, height: zoom.height } })

      for (const story of STORIES) {
        test(`${story} reflows without sideways scrolling`, async ({ page }) => {
          await openStory(page, story)

          const box = await page.evaluate(() => {
            const doc = document.documentElement
            return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
          })

          expect(
            box.scrollWidth,
            `document is ${box.scrollWidth}px wide in a ${box.clientWidth}px viewport at 200% zoom`
          ).toBeLessThanOrEqual(box.clientWidth + 1)
        })
      }

      test('no text is clipped by a fixed-height container', async ({ page }) => {
        await openStory(page, 'responsive-surfaces--forms')

        // Enlarged text overflowing a container with a hard height is the other
        // half of 1.4.4, and it is invisible to a document-width check: the
        // page fits, the words are simply cut off inside a box.
        const clipped = await page.evaluate(() => {
          const bad = []
          for (const el of document.querySelectorAll('label, p, h1, h2, h3, button, .lx-field__label')) {
            const cs = getComputedStyle(el)
            if (cs.overflow === 'visible' || el.scrollHeight <= el.clientHeight + 1) continue
            if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') continue
            bad.push(`${el.tagName.toLowerCase()}.${el.className || '(no class)'}: ${el.scrollHeight}px in ${el.clientHeight}px`)
          }
          return bad
        })

        expect(clipped, 'text clipped by a fixed-height container').toEqual([])
      })
    })
  }
})
