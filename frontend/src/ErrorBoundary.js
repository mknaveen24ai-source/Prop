import React from 'react'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    console.error('Frontend Edge Case Error Caught:', error, errorInfo)
    this.setState({ error, errorInfo })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: '100vh', width: '100%', 
          display: 'flex', flexDirection: 'column', 
          justifyContent: 'center', alignItems: 'center', 
          background: 'var(--navy-bg, #0b0f19)', 
          color: 'var(--text, #e2e8f0)',
          fontFamily: 'system-ui, sans-serif'
        }}>
          <h1 style={{ color: 'var(--accent, #3b82f6)', marginBottom: '10px' }}>Something went wrong.</h1>
          <p style={{ color: 'var(--text-muted, #94a3b8)', maxWidth: '500px', textAlign: 'center', lineHeight: '1.5' }}>
            We encountered an unexpected error while rendering this page. 
            This might be due to a network interruption or missing data. 
          </p>
          <div style={{ marginTop: '30px', display: 'flex', gap: '15px' }}>
            <button 
              onClick={() => window.location.reload()}
              style={{ padding: '10px 20px', background: 'var(--accent, #3b82f6)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Refresh Page
            </button>
            <button 
              onClick={() => window.location.href = '/'}
              style={{ padding: '10px 20px', background: 'transparent', color: 'var(--text, #e2e8f0)', border: '1px solid var(--navy-border, #1e293b)', borderRadius: '5px', cursor: 'pointer' }}
            >
              Go Home
            </button>
          </div>
          {process.env.NODE_ENV === 'development' && this.state.error && (
            <div style={{ marginTop: '40px', padding: '20px', background: 'var(--navy-card, #111827)', border: '1px solid var(--red, #ef4444)', borderRadius: '5px', width: '80%', maxWidth: '800px', overflowX: 'auto' }}>
              <pre style={{ color: 'var(--red, #ef4444)', fontSize: '12px', margin: 0 }}>
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