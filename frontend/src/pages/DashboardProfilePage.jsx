import React from 'react'
import Card from '../components/ui/Card'

const COUNTRY_OPTIONS = [
  'India', 'United Kingdom', 'Australia', 'UAE', 'South Africa', 'Nigeria',
  'Malaysia', 'Singapore', 'Philippines', 'Kenya', 'Pakistan', 'Bangladesh', 'Other'
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
}) {
  const identityLocked = kycStatus === 'approved'

  function updateField(field, value) {
    setProfileForm((f) => ({ ...f, [field]: value }))
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
        Profile
      </h2>

      <Card style={{ maxWidth: '700px' }}>
        <h3 style={{ marginBottom: '20px', color: 'var(--accent)' }}>Name & Address</h3>
        <form onSubmit={updateProfile}>
          <div className="grid-2">
            <div>
              <label>Full Name</label>
              <input
                type="text"
                value={profileForm.full_name}
                onChange={(e) => updateField('full_name', e.target.value)}
                disabled={identityLocked}
                required
              />
              {identityLocked && (
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Contact support to change your legal name after KYC verification.
                </p>
              )}
            </div>
            <div>
              <label>Country</label>
              <select
                value={profileForm.country}
                onChange={(e) => updateField('country', e.target.value)}
                disabled={identityLocked}
                required
              >
                <option value="">Select your country</option>
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {identityLocked && (
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Contact support to change your country after KYC verification.
                </p>
              )}
            </div>
          </div>

          <div style={{ marginTop: '16px' }}>
            <label>Address Line 1</label>
            <input
              type="text"
              value={profileForm.address_line1}
              onChange={(e) => updateField('address_line1', e.target.value)}
              placeholder="Street address"
            />
          </div>

          <div style={{ marginTop: '16px' }}>
            <label>Address Line 2 (optional)</label>
            <input
              type="text"
              value={profileForm.address_line2}
              onChange={(e) => updateField('address_line2', e.target.value)}
              placeholder="Apartment, suite, unit, etc."
            />
          </div>

          <div className="grid-2" style={{ marginTop: '16px' }}>
            <div>
              <label>City</label>
              <input
                type="text"
                value={profileForm.city}
                onChange={(e) => updateField('city', e.target.value)}
              />
            </div>
            <div>
              <label>State / Province</label>
              <input
                type="text"
                value={profileForm.state_province}
                onChange={(e) => updateField('state_province', e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginTop: '16px', maxWidth: '240px' }}>
            <label>Postal Code</label>
            <input
              type="text"
              value={profileForm.postal_code}
              onChange={(e) => updateField('postal_code', e.target.value)}
            />
          </div>

          <button
            className="btn btn-accent"
            type="submit"
            style={{ marginTop: '20px', padding: '12px 32px' }}
            disabled={profileSaving}
          >
            {profileSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </Card>
    </div>
  )
}
