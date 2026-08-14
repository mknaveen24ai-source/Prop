import { useEffect } from 'react'
import axios from 'axios'
import { API_BASE_URL as API_URL } from '../../../config/apiBase'

// Backstop for the socket's kyc_status_changed event: polls /auth/me every 30s
// so an approval still lands if the socket dropped.
export default function useKycStatusPolling(kycStatus, setKycStatus) {
  useEffect(() => {
    const pollKyc = async () => {
      try {
        const res = await axios.get(`${API_URL}/api/auth/me`)
        const newStatus = res.data?.kyc_status
        if (newStatus && newStatus !== kycStatus) {
          setKycStatus(newStatus)
        }
      } catch {}
    }
    const interval = setInterval(pollKyc, 30000)
    return () => clearInterval(interval)
  }, [kycStatus]) // eslint-disable-line react-hooks/exhaustive-deps
}
