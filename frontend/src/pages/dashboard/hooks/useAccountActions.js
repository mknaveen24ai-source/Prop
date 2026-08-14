import { useEffect, useState } from 'react'
import axios from 'axios'
import toast from 'react-hot-toast'
import { createIdempotencyHeaders, normalizeApiError, authAPI } from '../../../services/api'
import { API_BASE_URL as API_URL } from '../../../config/apiBase'

// Challenge account creation, the Stripe checkout return handler, the payout
// request form and the profile form — the account-lifecycle actions that are
// not trade entry.
export default function useAccountActions({ user, login, selectedAccount, setError, setSuccess, fetchAccounts, fetchPayouts }) {
  const [accountSubmitting, setAccountSubmitting] = useState(false)
  const [payoutSubmitting, setPayoutSubmitting] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)

  // Quota state: set when the backend returns quota_full on account creation
  const [quotaFull, setQuotaFull] = useState(false)
  const [quotaNextOpen, setQuotaNextOpen] = useState(null)

  const [payoutForm, setPayoutForm] = useState({ amount_requested: '', payment_method: 'usdt_trc20', payment_details: '' })
  const [profileForm, setProfileForm] = useState({
    full_name: user?.full_name || '',
    country: user?.country || '',
    address_line1: user?.address_line1 || '',
    address_line2: user?.address_line2 || '',
    city: user?.city || '',
    state_province: user?.state_province || '',
    postal_code: user?.postal_code || ''
  })

  async function createAccount(size, options = {}) {
    if (accountSubmitting) return
    setAccountSubmitting(true)
    try {
      // Clear any previous quota state before trying
      setQuotaFull(false)
      setQuotaNextOpen(null)
      const payload = { account_size: size }
      if (options.challengeOrderId) {
        payload.challenge_order_id = options.challengeOrderId
      }
      await axios.post(`${API_URL}/api/accounts/create`, payload, {
        headers: createIdempotencyHeaders('accounts:create'),
        skipAuthRedirect: true
      })
      setSuccess('Challenge account created!')
      fetchAccounts()
    } catch (err) {
      const data = err.response?.data
      if (data?.quota_full) {
        // Backend told us quota is full — show the dedicated banner instead of the error toast
        setQuotaFull(true)
        setQuotaNextOpen(data.next_open || null)
      } else {
        setError(normalizeApiError(err, 'Could not create account').message)
      }
    } finally {
      setAccountSubmitting(false)
    }
  }

  // After a challenge order is paid, Stripe redirects back to
  // /dashboard?checkout=success&order_id=N. Webhook delivery can lag a few
  // seconds behind the redirect, so poll the order until it's marked paid,
  // then create the challenge account.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const checkout = params.get('checkout')
    const orderId = params.get('order_id')
    if (!checkout) return

    window.history.replaceState({}, '', window.location.pathname)

    if (checkout === 'cancelled') {
      toast.error('Checkout was cancelled — no charge was made.')
      return
    }
    if (checkout !== 'success' || !orderId) return

    let cancelled = false
    async function confirmPayment() {
      setSuccess('Confirming your payment...')
      for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
        try {
          const res = await axios.get(`${API_URL}/api/accounts/orders/${orderId}`)
          const order = res.data?.order
          if (order?.status === 'paid') {
            if (order.is_gift) {
              // Gift orders never create an account for the buyer — a
              // redemption voucher was issued to the recipient instead
              // (see backend/utils/giftVouchers.js).
              setSuccess(`Gift sent to ${order.gift_recipient_email}! They'll receive an email with a redemption code.`)
              return
            }
            await createAccount(parseFloat(order.account_size), { challengeOrderId: order.id })
            return
          }
        } catch (_) {
          // keep retrying — webhook may not have landed yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      if (!cancelled) {
        setError('Payment is taking longer than expected to confirm. If you were charged, your account will appear shortly — refresh in a minute or contact support.')
      }
    }
    confirmPayment()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function requestPayout(e) {
    e.preventDefault()
    if (payoutSubmitting) return
    setPayoutSubmitting(true)
    try {
      await axios.post(`${API_URL}/api/payouts/request`, {
        account_id: selectedAccount.id,
        amount_requested: parseFloat(payoutForm.amount_requested),
        payment_method: payoutForm.payment_method,
        payment_details: payoutForm.payment_details
      }, {
        headers: createIdempotencyHeaders('payouts:request')
      })
      setSuccess('Payout request submitted!')
      setPayoutForm({ amount_requested: '', payment_method: 'usdt_trc20', payment_details: '' })
      fetchPayouts()
    } catch (err) {
      setError(normalizeApiError(err, 'Could not submit payout').message)
    } finally {
      setPayoutSubmitting(false)
    }
  }

  async function updateProfile(e) {
    e.preventDefault()
    if (profileSaving) return
    setProfileSaving(true)
    try {
      const res = await authAPI.updateProfile(profileForm)
      login(res.data)
      setSuccess('Profile updated!')
    } catch (err) {
      setError(normalizeApiError(err, 'Could not update profile').message)
    } finally {
      setProfileSaving(false)
    }
  }

  return {
    createAccount,
    quotaFull,
    quotaNextOpen,
    payoutForm,
    setPayoutForm,
    requestPayout,
    profileForm,
    setProfileForm,
    profileSaving,
    updateProfile
  }
}
