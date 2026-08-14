import { useEffect, useState } from 'react'
import api from '../../../services/api'

// Price feed health, polled every 5s so the panel can warn when quotes go
// stale rather than letting a trader act on a frozen price.
export default function usePriceFeedStatus() {
  const [priceStatus, setPriceStatus] = useState({ healthy: true, instruments: {} })

  useEffect(() => {
    async function fetchPriceStatus() {
      try {
        const res = await api.get('/api/price-status')
        setPriceStatus(res.data)
      } catch (err) {
        setPriceStatus({ healthy: false, message: 'Unable to check price feed status' })
      }
    }
    fetchPriceStatus()
    const interval = setInterval(fetchPriceStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  return priceStatus
}
