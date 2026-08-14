import { useState } from 'react'
import axios from 'axios'
import { API_BASE_URL as API_URL } from '../../../config/apiBase'

const KYC_DOC_FIELD_NAMES = { id: 'id_document', id_back: 'id_document_back', selfie: 'selfie' }

// Identity verification form. Returns one object so DashboardKYCPage can take
// {...kyc} instead of the 16 individual props it used to be handed.
//
// kycStatus is also written by the socket's kyc_status_changed handler, so its
// setter is returned.
export default function useKycForm({ user, setError, setSuccess }) {
  const [kycStatus, setKycStatus] = useState(user?.kyc_status || 'not_submitted')
  const [kycCountry, setKycCountry] = useState(user?.kyc_document_country || user?.country || '')
  const [kycDocumentType, setKycDocumentType] = useState(user?.kyc_document_type || 'passport')
  const [kycDocumentNumber, setKycDocumentNumber] = useState(user?.kyc_document_number || '')
  const [idDocument, setIdDocument] = useState(null)
  const [idDocumentBack, setIdDocumentBack] = useState(null)
  const [selfie, setSelfie] = useState(null)
  const [kycUploading, setKycUploading] = useState(false)

  async function uploadKYC(e) {
    e.preventDefault()
    if (!idDocument || !idDocumentBack || !selfie) {
      return setError('Please upload ID front, ID back, and live photo')
    }
    if (!kycCountry.trim()) return setError('Please enter your country of residence')
    if (!kycDocumentType) return setError('Please choose your document type')
    if (!kycDocumentNumber.trim()) return setError('Please enter your document number')
    try {
      setKycUploading(true)
      const formData = new FormData()
      formData.append('country', kycCountry.trim())
      formData.append('document_type', kycDocumentType)
      formData.append('document_number', kycDocumentNumber.trim())
      formData.append('id_document', idDocument)
      formData.append('id_document_back', idDocumentBack)
      formData.append('selfie', selfie)
      await axios.post(`${API_URL}/api/kyc/upload`, formData)
      setKycStatus('pending')
      setSuccess('KYC documents uploaded! Admin will review within 24 hours.')
      setIdDocument(null)
      setIdDocumentBack(null)
      setSelfie(null)
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed')
    } finally {
      setKycUploading(false)
    }
  }

  // Lets a trader replace a single rejected KYC document (e.g. just the
  // selfie) instead of resubmitting all three files via uploadKYC() above —
  // backend's POST /api/kyc/upload accepts any subset of the three fields
  // and keeps whatever isn't resent as-is.
  async function uploadSingleKycDocument(docType, file) {
    const fieldName = KYC_DOC_FIELD_NAMES[docType]
    if (!fieldName || !file) return false
    try {
      setKycUploading(true)
      const formData = new FormData()
      formData.append(fieldName, file)
      await axios.post(`${API_URL}/api/kyc/upload`, formData)
      setKycStatus('pending')
      setSuccess('Document replaced! Admin will review within 24 hours.')
      return true
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed')
      return false
    } finally {
      setKycUploading(false)
    }
  }

  return {
    kycStatus,
    setKycStatus,
    kycCountry,
    setKycCountry,
    kycDocumentType,
    setKycDocumentType,
    kycDocumentNumber,
    setKycDocumentNumber,
    idDocument,
    setIdDocument,
    idDocumentBack,
    setIdDocumentBack,
    selfie,
    setSelfie,
    kycUploading,
    uploadKYC,
    uploadSingleKycDocument
  }
}
