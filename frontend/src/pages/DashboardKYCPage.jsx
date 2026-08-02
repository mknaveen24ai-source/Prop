import React from 'react'
import KYCUploadForm from '../components/dashboard/KYCUploadForm'
import { renderIcon } from '../utils/iconMap'

/**
 * DashboardKYCPage — Identity Verification tab.
 *
 * Receives all KYC state and callbacks from Dashboard.jsx via props.
 */
export default function DashboardKYCPage({
  user,
  kycStatus,
  uploadKYC,
  kycCountry, setKycCountry,
  kycDocumentType, setKycDocumentType,
  kycDocumentNumber, setKycDocumentNumber,
  idDocument, setIdDocument,
  idDocumentBack, setIdDocumentBack,
  selfie, setSelfie,
  kycUploading,
}) {
  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
        Identity Verification
      </h2>

      {kycStatus === 'approved' ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('approve', { size: 48, color: 'var(--accent-green)' })}
          </div>
          <h3 style={{ color: 'var(--green)', marginBottom: '12px' }}>KYC Verified</h3>
          <p style={{ color: 'var(--text-muted)' }}>Your identity has been verified. You can start trading.</p>
        </div>

      ) : kycStatus === 'pending' ? (
        <div className="card" style={{
          textAlign: 'left', padding: '28px', marginBottom: '20px',
          border: '1px solid color-mix(in srgb, var(--accent-gold) 35%, transparent)', maxWidth: '720px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '10px' }}>
            {renderIcon('timer', { size: 40, color: 'var(--accent-gold)' })}
            <div>
              <h3 style={{ color: 'var(--accent)', margin: 0 }}>KYC Under Review</h3>
              <p style={{ color: 'var(--text-muted)', margin: '6px 0 0', lineHeight: 1.6 }}>
                Your documents were submitted successfully. The upload form is locked while admin reviews your
                KYC. If it is declined, you can resubmit corrected documents here.
              </p>
            </div>
          </div>
        </div>

      ) : (
        <div>
          {kycStatus === 'rejected' && (
            <div className="card" style={{
              textAlign: 'center', padding: '24px', marginBottom: '20px',
              border: '1px solid var(--red)', maxWidth: '720px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
                {renderIcon('reject', { size: 32, color: 'var(--accent-red)' })}
              </div>
              <h3 style={{ color: 'var(--red)', marginBottom: '8px' }}>KYC Rejected</h3>
              <p style={{ color: 'var(--text-muted)' }}>Your documents were rejected. Please re-submit.</p>
              {user?.kyc_rejection_reason && (
                <div style={{
                  marginTop: '12px', padding: '12px 16px',
                  background: 'color-mix(in srgb, var(--muted) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)',
                  textAlign: 'left'
                }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>
                    Reason from Admin
                  </div>
                  <div style={{ fontSize: '14px', color: 'var(--text)' }}>{user.kyc_rejection_reason}</div>
                </div>
              )}
            </div>
          )}

          <KYCUploadForm
            onSubmit={uploadKYC}
            country={kycCountry}
            setCountry={setKycCountry}
            documentType={kycDocumentType}
            setDocumentType={setKycDocumentType}
            documentNumber={kycDocumentNumber}
            setDocumentNumber={setKycDocumentNumber}
            idDocument={idDocument}
            setIdDocument={setIdDocument}
            idDocumentBack={idDocumentBack}
            setIdDocumentBack={setIdDocumentBack}
            selfie={selfie}
            setSelfie={setSelfie}
            uploading={kycUploading}
          />
        </div>
      )}
    </div>
  )
}
