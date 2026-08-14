import { useEffect, useState } from 'react'

// The dashboard's single error/success banner pair. Almost every action and
// socket handler writes to these, so they are their own hook rather than being
// threaded through the data/trade hooks.
//
// Both clear themselves 5s after the last write.
export default function useDashboardFeedback() {
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (error || success) {
      const t = setTimeout(() => { setError(''); setSuccess('') }, 5000)
      return () => clearTimeout(t)
    }
  }, [error, success])

  return { error, setError, success, setSuccess }
}
