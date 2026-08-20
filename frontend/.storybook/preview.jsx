import '../src/styles/tokens.css'
import '../src/styles/primitives.css'
import '../src/components/ui/ui.css'
import '../src/components/ui/skeleton.css'

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
    a11y: { test: 'todo' }
  }
}

export default preview
