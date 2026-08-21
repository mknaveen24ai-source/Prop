// App.css is the real entry sheet: it @imports tokens, primitives, responsive,
// the three mode sheets, ui.css, the ledger-desk overrides and animations, in
// that order. Importing it wholesale rather than hand-picking four files means
// the cascade here is the cascade the app has -- including the media queries
// that raise controls to --touch-min and --input-font-mobile below `md`.
//
// The hand-picked list this replaces omitted App.css and admin.css entirely, so
// .input-field and .admin-table-wrapper had NO styles in Storybook. Stories
// still looked plausible, which is the dangerous part: the viewport matrix read
// unstyled inputs as 13px tap targets and an admin table with no scroller, and
// reported eighteen failures against a codebase where none of them were true.
import '../src/App.css'
import '../src/components/ui/skeleton.css'
// Loaded after App.css, matching the app, where AdminLayout pulls it in at the
// route rather than globally.
import '../src/pages/admin/admin.css'

/**
 * Storybook preview.
 *
 * Loads the real token sheet rather than a Storybook-specific copy, so a story
 * cannot look right while the app looks wrong. The theme toolbar stamps
 * `data-theme` on <html>, which is exactly what ThemeContext does at runtime --
 * both themes are therefore exercised through the same mechanism the product
 * uses, not a Storybook approximation of it.
 */

/** @type { import('@storybook/react-vite').Preview } */
const preview = {
  globalTypes: {
    theme: {
      description: 'Colour theme',
      defaultValue: 'dark',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' }
        ],
        dynamicTitle: true
      }
    }
  },

  decorators: [
    (Story, context) => {
      const theme = context.globals.theme || 'dark'
      document.documentElement.setAttribute('data-theme', theme)
      // The canvas is transparent by default, so without an explicit ground the
      // light theme renders light text on Storybook's own white and looks
      // broken for reasons that have nothing to do with the component.
      document.body.style.background = 'var(--paper)'
      document.body.style.color = 'var(--ink)'
      return <Story />
    }
  ],

  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    // 'error' rather than 'todo': the addon was installed and registered but
    // set to report-only, so it has been finding violations and failing nothing
    // since the day it was added. Stories render fixed content against the real
    // stylesheet (preview loads App.css wholesale), so an axe run over them is
    // deterministic and belongs in CI.
    a11y: { test: 'error' }
  }
}

export default preview
