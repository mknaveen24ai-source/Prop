import React, { useEffect, useState } from 'react'
import KYCUploadForm from '../components/dashboard/KYCUploadForm'
import Card from '../components/ui/Card'
import { kycAPI } from '../services/api'
import { renderIcon } from '../utils/iconMap'
import { API_BASE_URL as API_URL } from '../config/apiBase'


// <img> preview with a graceful fallback to an "Open document" link for
// non-image uploads (PDFs) — the endpoint decides the real Content-Type,
// this just reacts to whether the browser could render it as an image.
function DocThumbnail({ docType }) {
  const [imageFailed, setImageFailed] = useState(false)
  const src = `${API_URL}/api/kyc/document/${docType}`

  if (imageFailed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        style={{ width: '44px', height: '56px', flex: '0 0 auto', border: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper-2)' }}
        title="Open document in a new tab"
      >
        {renderIcon('file', { size: 18, color: 'var(--muted)' })}
      </a>
    )
  }

  return (
    <img
      src={src}
      alt="Document preview"
      onError={() => setImageFailed(true)}
      style={{ width: '44px', height: '56px', flex: '0 0 auto', border: '1px solid var(--rule)', objectFit: 'cover', background: 'var(--paper-2)' }}
    />
  )
}

// Lets a trader replace one rejected document without reopening the full
// upload form — a hidden file input triggered by a visible button.
function ReplaceDocButton({ docType, onUpload, uploading }) {
  const inputRef = React.useRef(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setSubmitting(true)
    await onUpload(docType, file)
    setSubmitting(false)
    e.target.value = ''
  }

  const busy = submitting || uploading

  return (
    <>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleChange} style={{ display: 'none' }} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="lx-btn"
        style={{ marginTop: 'var(--space-2)', padding: 'var(--space-1-5) var(--space-3)', border: '1px solid var(--warn)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--warn)', fontSize: '11.5px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
      >
        {busy ? 'Uploading…' : 'Replace this document'}
      </button>
    </>
  )
}

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
  uploadSingleKycDocument,
}) {
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(false)
  const [detailLoading, setDetailLoading] = useState(true)

  function fetchDetail() {
    setDetailLoading(true)
    kycAPI.getStatus()
      .then((res) => { setDetail(res.data); setDetailError(false) })
      .catch(() => setDetailError(true))
      .finally(() => setDetailLoading(false))
  }

  useEffect(() => {
    fetchDetail()
  }, [kycStatus])

  const [showFullForm, setShowFullForm] = useState(false)
  const steps = computeSteps(kycStatus)
  const submittedDate = formatDate(detail?.kyc_submitted_at)
  // On rejection, documents already exist — default to letting the trader
  // replace just the flagged one(s) instead of forcing the full first-time
  // upload form back open (which re-asks for country/document type/number
  // too). "Resubmit everything" below still opens the full form for cases
  // where those details were what was actually wrong.
  const allowPerDocReplace = kycStatus === 'rejected' && !showFullForm
  const showUploadForm = (kycStatus !== 'approved' && kycStatus !== 'pending' && kycStatus !== 'rejected') || (kycStatus === 'rejected' && showFullForm)

  const docs = [
    {
      title: 'ID Document — Front',
      docType: 'id',
      present: Boolean(detail?.has_id_document),
      note: detail?.kyc_document_type ? `${detail.kyc_document_type.replace(/_/g, ' ')} · issued in ${detail?.kyc_document_country || 'your country'}` : 'Front side of your passport, national ID, license, or residence permit.',
    },
    {
      title: 'ID Document — Back',
      docType: 'id_back',
      present: Boolean(detail?.has_id_document_back),
      note: 'Back side of the same document (or the ID page again, for a single-page passport).',
    },
    {
      title: 'Live Selfie',
      docType: 'selfie',
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
    <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-4-5)' }}>
      {detailError && (
        <Card style={{ border: '1px solid var(--warn)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3-5)', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--warn)' }}>Couldn't load your document status</div>
              <div style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: '5px' }}>
                {detail ? 'Showing your last known status — this may be out of date.' : "The document cards below can't be confirmed right now, so they may not reflect what you've actually submitted."}
              </div>
            </div>
            <button type="button" onClick={fetchDetail} className="lx-btn" style={{ padding: 'var(--space-2) var(--space-3-5)', border: '1px solid var(--warn)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--warn)', flex: '0 0 auto' }}>
              Retry
            </button>
          </div>
        </Card>
      )}

      {kycStatus === 'rejected' && user?.kyc_rejection_reason && (
        <Card style={{ border: '1px solid var(--loss)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--loss)' }}>Reason from admin</div>
          <div style={{ fontSize: 'var(--fs-md)', marginTop: 'var(--space-2)' }}>{user.kyc_rejection_reason}</div>
        </Card>
      )}

      {/* Step tracker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0', background: 'var(--glass)', backdropFilter: 'blur(16px)', border: '1px solid var(--rule)', borderRadius: '4px', boxShadow: 'var(--elev)', padding: 'var(--space-4-5) var(--space-5)', flexWrap: 'wrap' }}>
        {steps.map((st) => (
          <div key={st.label} style={{ flex: '1 1 180px', minWidth: '160px', padding: 'var(--space-1) var(--space-3-5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)' }}>
              <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: st.tone, flex: '0 0 auto' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: st.tone }}>{st.state}</div>
                <div style={{ fontSize: '13.5px', marginTop: '3px' }}>{st.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="ui-split" style={{ alignItems: 'start', '--split': 'minmax(0,1.25fr) minmax(0,1fr)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3-5)' }}>
          {detailLoading && !detail && !detailError && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Checking your document status…</div>
          )}
          {docs.map((doc) => {
            const status = docStatus(doc.present)
            return (
              <Card key={doc.title}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3-5)' }}>
                  {doc.present ? (
                    <DocThumbnail docType={doc.docType} />
                  ) : (
                    <span style={{ width: '44px', height: '56px', flex: '0 0 auto', border: '1px solid var(--rule)', background: 'repeating-linear-gradient(45deg,var(--paper-2),var(--paper-2) 6px,var(--paper) 6px,var(--paper) 12px)' }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)', flexWrap: 'wrap' }}>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px' }}>{doc.title}</div>
                      <span className="lx-badge" style={{ color: status.tone }}>{status.label}</span>
                    </div>
                    <div style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: '5px', lineHeight: 1.55 }}>{doc.note}</div>
                    {doc.present && submittedDate && (
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '7px' }}>Submitted {submittedDate}</div>
                    )}
                    {allowPerDocReplace && (
                      <ReplaceDocButton docType={doc.docType} onUpload={uploadSingleKycDocument} uploading={kycUploading} />
                    )}
                  </div>
                </div>
              </Card>
            )
          })}

          {allowPerDocReplace && (
            <button
              type="button"
              onClick={() => setShowFullForm(true)}
              style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 'var(--fs-sm)', textDecoration: 'underline', cursor: 'pointer', padding: 0, textAlign: 'left' }}
            >
              Need to fix your country or document type too? Resubmit everything instead.
            </button>
          )}

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
            <Card style={{ textAlign: 'center', padding: 'var(--space-5)', color: 'var(--muted)', fontSize: 'var(--fs-base)' }}>
              Your documents are locked while admin reviews them. If declined, you'll be able to resubmit here.
            </Card>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Card ruled title="What we check">
            {KYC_REQS.map((label) => (
              <div key={label} style={{ display: 'flex', gap: 'var(--space-2-5)', padding: '9px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                <span style={{ color: 'var(--accent)', marginTop: '2px' }}>·</span>
                <div style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'var(--muted)' }}>{label}</div>
              </div>
            ))}
          </Card>

          <Card style={{ border: '1px solid var(--accent)', background: 'var(--glass-2)' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--accent)' }}>Why now</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', marginTop: '7px' }}>
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
