import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import KYCUploadForm from './KYCUploadForm'

/**
 * Client-side file validation on the KYC upload.
 *
 * This runs before anything reaches the server, so it is the only thing
 * standing between a trader and a 5MB upload that fails minutes later, or a
 * .exe renamed to .jpg being attached to an identity check. It had no test.
 *
 * The component is controlled, so the harness below holds the state it would
 * normally get from DashboardKYCPage — that is what makes "the file was
 * rejected" observable: `setIdDocument(null)` is the rejection.
 */

const MAX = 5 * 1024 * 1024

/** A File whose reported size can exceed what we want to hold in memory. */
function makeFile(name, type, size = 1024) {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function Harness({ onState }) {
  const [idDocument, setIdDocument] = useState(null)
  const [idDocumentBack, setIdDocumentBack] = useState(null)
  const [selfie, setSelfie] = useState(null)
  const [country, setCountry] = useState('India')
  const [documentType, setDocumentType] = useState('passport')
  const [documentNumber, setDocumentNumber] = useState('')

  onState?.({ idDocument, idDocumentBack, selfie })

  return (
    <KYCUploadForm
      onSubmit={vi.fn()}
      country={country}
      setCountry={setCountry}
      documentType={documentType}
      setDocumentType={setDocumentType}
      documentNumber={documentNumber}
      setDocumentNumber={setDocumentNumber}
      idDocument={idDocument}
      setIdDocument={setIdDocument}
      idDocumentBack={idDocumentBack}
      setIdDocumentBack={setIdDocumentBack}
      selfie={selfie}
      setSelfie={setSelfie}
      uploading={false}
    />
  )
}

function renderForm() {
  const state = {}
  render(<Harness onState={(s) => Object.assign(state, s)} />)
  return state
}

/**
 * The file inputs are `display: none` behind styled drop boxes, so they are
 * reached through their labels. getByLabelText resolves via the accessibility
 * tree, so this also asserts each input really is labelled — the association
 * that makes the control reachable at all for a screen-reader user.
 */
function fileInput(label) {
  return screen.getByLabelText(label)
}

const ID_FRONT = 'ID Document Front'
const SELFIE = 'Live Photo / Selfie'

describe('KYCUploadForm file validation', () => {
  it('accepts a JPG within the size limit', () => {
    const state = renderForm()
    fireEvent.change(fileInput(ID_FRONT), {
      target: { files: [makeFile('passport.jpg', 'image/jpeg', 200 * 1024)] },
    })
    expect(state.idDocument).not.toBeNull()
    expect(state.idDocument.name).toBe('passport.jpg')
  })

  it('rejects a disallowed type and says which document', () => {
    const state = renderForm()
    fireEvent.change(fileInput(ID_FRONT), {
      target: { files: [makeFile('malware.exe', 'application/x-msdownload')] },
    })
    expect(screen.getByText(/ID front document must be JPG, PNG, or PDF/i)).toBeInTheDocument()
    expect(state.idDocument).toBeNull()
  })

  it('rejects a file over 5MB', () => {
    const state = renderForm()
    fireEvent.change(fileInput(ID_FRONT), {
      target: { files: [makeFile('scan.jpg', 'image/jpeg', MAX + 1)] },
    })
    expect(screen.getByText(/ID front document must be under 5MB/i)).toBeInTheDocument()
    expect(state.idDocument).toBeNull()
  })

  it('accepts a file exactly at the limit', () => {
    // The boundary is `> MAX`, so exactly 5MB must pass. An off-by-one here
    // rejects a file the server would have accepted.
    const state = renderForm()
    fireEvent.change(fileInput(ID_FRONT), {
      target: { files: [makeFile('scan.jpg', 'image/jpeg', MAX)] },
    })
    expect(state.idDocument).not.toBeNull()
  })

  it('clears a previously accepted file when a bad one replaces it', () => {
    // Otherwise the form still holds the old file while showing an error, and
    // submitting uploads something the user thinks they replaced.
    const state = renderForm()
    const input = fileInput(ID_FRONT)
    fireEvent.change(input, { target: { files: [makeFile('good.jpg', 'image/jpeg')] } })
    expect(state.idDocument).not.toBeNull()

    fireEvent.change(input, { target: { files: [makeFile('bad.exe', 'application/x-msdownload')] } })
    expect(state.idDocument).toBeNull()
  })

  it('rejects a PDF for the selfie but allows it for the ID', () => {
    // The two inputs have different allow-lists on purpose: a PDF is a valid
    // scanned ID and is not a live photo.
    const state = renderForm()
    fireEvent.change(fileInput(ID_FRONT), {
      target: { files: [makeFile('id.pdf', 'application/pdf')] },
    })
    expect(state.idDocument).not.toBeNull()

    fireEvent.change(fileInput(SELFIE), {
      target: { files: [makeFile('me.pdf', 'application/pdf')] },
    })
    expect(screen.getByText(/Live photo must be JPG or PNG/i)).toBeInTheDocument()
    expect(state.selfie).toBeNull()
  })

  it('ignores an empty selection, as a cancelled file dialog produces', () => {
    const state = renderForm()
    fireEvent.change(fileInput(ID_FRONT), {
      target: { files: [makeFile('good.jpg', 'image/jpeg')] },
    })
    fireEvent.change(fileInput(ID_FRONT), { target: { files: [] } })
    // Cancelling must not wipe the file already chosen.
    expect(state.idDocument).not.toBeNull()
  })
})
