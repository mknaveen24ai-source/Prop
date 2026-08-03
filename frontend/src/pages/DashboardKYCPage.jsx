import React, { useEffect, useState } from 'react'
import KYCUploadForm from '../components/dashboard/KYCUploadForm'
import Card from '../components/ui/Card'
import { kycAPI } from '../services/api'

const STEP_LABELS = ['Country & document details', 'Documents uploaded', 'Admin review', 'Verified']

function computeSteps(kycStatus) {
  if (kycStatus === 'approved') {
    return STEP_LABELS.map((label) => ({ label, state: 'Done', tone: 'var(--gain)' }))
  }
  if (kycStatus === 'rejected') {
    return [
      { label: STEP_LABELS[0], state: 'Done', tone: 'var(--gain)' },
      { label: STEP_LABELS[1], state: 'Done', tone: 'var(--gain)' },
      { label: STEP_LABELS[2], state: 'Rejected', tone: 'var(--loss)' },
      { label: STEP_LABELS[3], state: 'Blocked', tone: 'var(--muted)' },
    ]
  }
  if (kycStatus === 'pending') {
    return [
      { label: STEP_LABELS[0], state: 'Done', tone: 'var(--gain)' },
      { label: STEP_LABELS[1], state: 'Done', tone: 'var(--gain)' },
      { label: STEP_LABELS[2], state: 'In review', tone: 'var(--warn)' },
      { label: STEP_LABELS[3], state: 'Pending', tone: 'var(--muted)' },
    ]
  }
  return STEP_LABELS.map((label) => ({ label, state: 'Pending', tone: 'var(--muted)' }))
}

const KYC_REQS = [
  'Full legal name matches the name on your account',
  'Document is current and not expired',
  'All four corners of the document are visible, with no glare',
  'Selfie clearly shows your face alongside the ID document',
  'Country of residence matches the issuing country on the document',
]

function formatDate(value) {
  if (!value) return null
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * DashboardKYCPage — Identity Verification tab (Modern Gazette handoff spec,
 * isKyc block: step tracker, per-document status cards, upload zone, "what
 * we check" checklist, "why now" gate explainer). Receives write-path state
 * (form fields, uploadKYC, kycStatus) from Dashboard.jsx as before; self-
 * fetches /api/kyc/status here for the richer read-only detail (document
 * country/type/number, per-file presence, submission date) that endpoint
 * exposes but the shared Dashboard.jsx state doesn't carry.
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
  const [detail, setDetail] = useState(null)

  useEffect(() => {
    kycAPI.getStatus()
      .then((res) => setDetail(res.data))
      .catch(() => setDetail(null))
  }, [kycStatus])

  const steps = computeSteps(kycStatus)
  const submittedDate = formatDate(detail?.kyc_submitted_at)
  const showUploadForm = kycStatus !== 'approved' && kycStatus !== 'pending'

  const docs = [
    {
      title: 'ID Document — Front',
      present: Boolean(detail?.has_id_document),
      note: detail?.kyc_document_type ? `${detail.kyc_document_type.replace(/_/g, ' ')} · issued in ${detail?.kyc_document_country || 'your country'}` : 'Front side of your passport, national ID, license, or residence permit.',
    },
    {
      title: 'ID Document — Back',
      present: Boolean(detail?.has_id_document_back),
      note: 'Back side of the same document (or the ID page again, for a single-page passport).',
    },
    {
      title: 'Live Selfie',
      present: Boolean(detail?.has_selfie),
      note: 'A live photo of you holding the same document, face and document both clearly visible.',
    },
  ]

  function docStatus(present) {
    if (!present) return { label: 'Not uploaded', tone: 'var(--muted)' }
    if (kycStatus === 'approved') return { label: 'Verified', tone: 'var(--gain)' }
    if (kycStatus === 'rejected') return { label: 'Rejected', tone: 'var(--loss)' }
    return { label: 'Submitted', tone: 'var(--warn)' }
  }

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '24px', margin: 0 }}>Identity Verification</h2>

      {kycStatus === 'rejected' && user?.kyc_rejection_reason && (
        <Card style={{ border: '1px solid var(--loss)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--loss)' }}>Reason from admin</div>
          <div style={{ fontSize: '14px', marginTop: '8px' }}>{user.kyc_rejection_reason}</div>
        </Card>
      )}

      {/* Step tracker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0', background: 'var(--glass)', backdropFilter: 'blur(16px)', border: '1px solid var(--rule)', borderRadius: '4px', boxShadow: 'var(--elev)', padding: '18px 20px', flexWrap: 'wrap' }}>
        {steps.map((st) => (
          <div key={st.label} style={{ flex: '1 1 180px', minWidth: '160px', padding: '4px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: st.tone, flex: '0 0 auto' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: st.tone }}>{st.state}</div>
                <div style={{ fontSize: '13.5px', marginTop: '3px' }}>{st.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)', gap: '16px', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {docs.map((doc) => {
            const status = docStatus(doc.present)
            return (
              <Card key={doc.title}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                  <span style={{ width: '44px', height: '56px', flex: '0 0 auto', border: '1px solid var(--rule)', background: 'repeating-linear-gradient(45deg,var(--paper-2),var(--paper-2) 6px,var(--paper) 6px,var(--paper) 12px)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px' }}>{doc.title}</div>
                      <span className="lx-badge" style={{ color: status.tone }}>{status.label}</span>
                    </div>
                    <div style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: '5px', lineHeight: 1.55 }}>{doc.note}</div>
                    {doc.present && submittedDate && (
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '7px' }}>Submitted {submittedDate}</div>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}

          {showUploadForm && (
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
          )}

          {kycStatus === 'pending' && (
            <Card style={{ textAlign: 'center', padding: '20px', color: 'var(--muted)', fontSize: '13px' }}>
              Your documents are locked while admin reviews them. If declined, you'll be able to resubmit here.
            </Card>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Card ruled title="What we check">
            {KYC_REQS.map((label) => (
              <div key={label} style={{ display: 'flex', gap: '10px', padding: '9px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                <span style={{ color: 'var(--accent)', marginTop: '2px' }}>·</span>
                <div style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'var(--muted)' }}>{label}</div>
              </div>
            ))}
          </Card>

          <Card style={{ border: '1px solid var(--accent)', background: 'var(--glass-2)' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--accent)' }}>Why now</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', marginTop: '7px' }}>
              {kycStatus === 'approved' ? 'Your identity is verified' : 'Verification is required before your first payout'}
            </div>
            <div style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: '7px', lineHeight: 1.6 }}>
              {kycStatus === 'approved'
                ? 'You can request payouts on any funded account without further checks.'
                : 'Payout requests are blocked until an admin approves your identity documents. Trading is unaffected — verify whenever you’re ready to withdraw.'}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
