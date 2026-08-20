import React from 'react'

// FIX (AUDIT): There was only ever one app-wide ErrorBoundary — a rendering
// crash in any single page or widget (e.g. the 1700-line TradingPanel, or any
// one Admin page) unmounted the ENTIRE app to this fallback, logging the user
// out of context everywhere. `variant="section"` renders a compact inline
// fallback with a "Try Again" reset instead of taking over the whole screen,
// so a section boundary can wrap individual pages/widgets without the
// blast radius of the top-level boundary.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    console.error(`Frontend error caught${this.props.label ? ` (${this.props.label})` : ''}:`, error, errorInfo)
    this.setState({ error, errorInfo })
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render() {
    if (this.state.hasError && this.props.variant === 'section') {
      return (
        <div style={{
          padding: 'var(--space-7) var(--space-6)',
          textAlign: 'center',
          border: '1px solid var(--loss, #f87171)',
          background: 'var(--paper-2, #1f1f1f)',
        }}>
          <p style={{ color: 'var(--text-primary)', fontWeight: 700, marginBottom: 'var(--space-1-5)' }}>
            {this.props.label ? `${this.props.label} failed to load` : 'This section failed to load'}
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-4-5)' }}>
            An unexpected error occurred here — the rest of the app is unaffected.
          </p>
          <button
            onClick={this.handleRetry}
            style={{ padding: '9px 22px', background: 'var(--accent)', color: 'var(--paper, #fff)', border: '1px solid var(--accent)', cursor: 'pointer', fontWeight: 600 }}
          >
            Try Again
          </button>
          {import.meta.env.DEV && this.state.error && (
            <pre style={{ marginTop: 'var(--space-4-5)', textAlign: 'left', fontSize: 'var(--fs-xs)', color: 'var(--danger)', overflowX: 'auto', maxWidth: '100%' }}>
              {this.state.error.toString()}
              {'\n'}
              {this.state.errorInfo?.componentStack}
            </pre>
          )}
        </div>
      )
    }

    if (this.state.hasError) {
      return (
        <div style={{
          height: '100dvh', width: '100%', 
          display: 'flex', flexDirection: 'column', 
          justifyContent: 'center', alignItems: 'center', 
          background: 'var(--paper, #161616)',
          color: 'var(--ink, #e8e4d8)',
          fontFamily: 'var(--font-ui, system-ui, sans-serif)'
        }}>
          <h1 style={{ color: 'var(--ink, #e8e4d8)', marginBottom: 'var(--space-2-5)' }}>Something went wrong.</h1>
          <p style={{ color: 'var(--muted, #8a8a82)', maxWidth: '500px', textAlign: 'center', lineHeight: '1.5' }}>
            We encountered an unexpected error while rendering this page.
            This might be due to a network interruption or missing data.
          </p>
          <div style={{ marginTop: '30px', display: 'flex', gap: '15px' }}>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: 'var(--space-2-5) var(--space-5)', background: 'var(--ink, #e8e4d8)', color: 'var(--paper, #161616)', border: '1px solid var(--ink, #e8e4d8)', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Refresh Page
            </button>
            <button
              onClick={() => window.location.href = '/'}
              style={{ padding: 'var(--space-2-5) var(--space-5)', background: 'transparent', color: 'var(--ink, #e8e4d8)', border: '1px solid var(--rule, #3a3a3a)', cursor: 'pointer' }}
            >
              Go Home
            </button>
          </div>
          {import.meta.env.DEV && this.state.error && (
            <div style={{ marginTop: 'var(--space-8)', padding: 'var(--space-5)', background: 'var(--paper-2, #1f1f1f)', border: '1px solid var(--loss, #f87171)', width: '80%', maxWidth: '800px', overflowX: 'auto' }}>
              <pre style={{ color: 'var(--loss, #f87171)', fontSize: 'var(--fs-sm)', margin: 0 }}>
                {this.state.error.toString()}
                <br/>
                {this.state.errorInfo?.componentStack}
              </pre>
            </div>
          )}
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary