import React, { useEffect, useState } from 'react'
import Card from '../components/ui/Card'
import Field from '../components/ui/Field'
import Button from '../components/ui/Button'
import TwoFactorSetup from '../components/TwoFactorSetup'
import { accountsAPI } from '../services/api'

const COUNTRY_OPTIONS = [
  { value: '', label: 'Select your country' },
  ...['India', 'United Kingdom', 'Australia', 'UAE', 'South Africa', 'Nigeria',
    'Malaysia', 'Singapore', 'Philippines', 'Kenya', 'Pakistan', 'Bangladesh', 'Other'].map((c) => ({ value: c, label: c }))
]

/**
 * DashboardProfilePage — Profile tab.
 *
 * Receives profile form state and the save handler from Dashboard.jsx via
 * props, mirroring DashboardPayoutsPage.jsx's pattern.
 */
export default function DashboardProfilePage({
  kycStatus,
  profileForm,
  setProfileForm,
  updateProfile,
  profileSaving,
  API_URL,
}) {
  const identityLocked = kycStatus === 'approved'
  const [platformRules, setPlatformRules] = useState(null)

  useEffect(() => {
    accountsAPI.getPlatformRules()
      .then((res) => setPlatformRules(res.data))
      .catch(() => setPlatformRules(null))
  }, [])

  function updateField(field, value) {
    setProfileForm((f) => ({ ...f, [field]: value }))
  }

  return (
    <div>
      <Card style={{ maxWidth: '700px' }}>
        <h3 style={{ marginBottom: 'var(--space-5)', color: 'var(--accent)' }}>Name & Address</h3>
        <form onSubmit={updateProfile}>
          <div className="grid-2">
            <Field
              label="Full Name"
              value={profileForm.full_name}
              onChange={(e) => updateField('full_name', e.target.value)}
              disabled={identityLocked}
              required
              hint={identityLocked ? 'Contact support to change your legal name after KYC verification.' : undefined}
            />
            <Field
              label="Country"
              type="select"
              options={COUNTRY_OPTIONS}
              value={profileForm.country}
              onChange={(e) => updateField('country', e.target.value)}
              disabled={identityLocked}
              required
              hint={identityLocked ? 'Contact support to change your country after KYC verification.' : undefined}
            />
          </div>

          <div style={{ marginTop: 'var(--space-4)' }}>
            <Field
              label="Address Line 1"
              value={profileForm.address_line1}
              onChange={(e) => updateField('address_line1', e.target.value)}
              placeholder="Street address"
            />
          </div>

          <div style={{ marginTop: 'var(--space-4)' }}>
            <Field
              label="Address Line 2 (optional)"
              value={profileForm.address_line2}
              onChange={(e) => updateField('address_line2', e.target.value)}
              placeholder="Apartment, suite, unit, etc."
            />
          </div>

          <div className="grid-2" style={{ marginTop: 'var(--space-4)' }}>
            <Field
              label="City"
              value={profileForm.city}
              onChange={(e) => updateField('city', e.target.value)}
            />
            <Field
              label="State / Province"
              value={profileForm.state_province}
              onChange={(e) => updateField('state_province', e.target.value)}
            />
          </div>

          <div style={{ marginTop: 'var(--space-4)', maxWidth: '240px' }}>
            <Field
              label="Postal Code"
              value={profileForm.postal_code}
              onChange={(e) => updateField('postal_code', e.target.value)}
            />
          </div>

          <Button type="submit" style={{ marginTop: 'var(--space-5)' }} disabled={profileSaving}>
            {profileSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </form>
      </Card>

      <div style={{ maxWidth: '700px', marginTop: 'var(--space-6)' }}>
        <h3 style={{ marginBottom: 'var(--space-3)', color: 'var(--accent)' }}>Security</h3>
        <TwoFactorSetup apiBase={API_URL} />
      </div>

      {platformRules && (
        <div style={{ maxWidth: '700px', marginTop: 'var(--space-6)' }}>
          <h3 style={{ marginBottom: 'var(--space-3)', color: 'var(--accent)' }}>Platform Trading Rules</h3>
          <Card>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px,1fr))', gap: 'var(--space-3-5)' }}>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Profit Share</div>
                <div style={{ fontSize: '15px', marginTop: 'var(--space-1)' }}>{platformRules.profit_share_pct}%</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Max Daily Trades</div>
                <div style={{ fontSize: '15px', marginTop: 'var(--space-1)' }}>{platformRules.max_daily_trades ?? 'Unlimited'}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Minimum Hold Time</div>
                <div style={{ fontSize: '15px', marginTop: 'var(--space-1)' }}>{platformRules.min_hold_seconds}s</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Minimum Lot Size</div>
                <div style={{ fontSize: '15px', marginTop: 'var(--space-1)' }}>{parseFloat(platformRules.min_lot_size || 0).toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Weekend Holding</div>
                <div style={{ fontSize: '15px', marginTop: 'var(--space-1)' }}>{platformRules.weekend_holding_enabled ? 'Allowed' : 'Not allowed'}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Inactivity Policy</div>
                <div style={{ fontSize: '15px', marginTop: 'var(--space-1)' }}>
                  {platformRules.inactivity_auto_fail_enabled ? `Auto-fail after ${platformRules.inactivity_fail_days} days idle` : 'No auto-fail'}
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
