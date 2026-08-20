import React, { useCallback, useEffect, useRef, useState } from 'react';
import Card from '../ui/Card';

const ALLOWED_ID_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
const ALLOWED_SELFIE_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda',
  'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain',
  'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan',
  'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
  'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia', 'Cameroon', 'Canada',
  'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros',
  'Congo', 'Costa Rica', "Cote d'Ivoire", 'Croatia', 'Cuba', 'Cyprus',
  'Czechia', 'Democratic Republic of the Congo', 'Denmark', 'Djibouti',
  'Dominica', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador',
  'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji',
  'Finland', 'France', 'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana',
  'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana',
  'Haiti', 'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran',
  'Iraq', 'Ireland', 'Israel', 'Italy', 'Jamaica', 'Japan', 'Jordan',
  'Kazakhstan', 'Kenya', 'Kiribati', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia',
  'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania',
  'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali',
  'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia',
  'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique',
  'Myanmar', 'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand',
  'Nicaragua', 'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway',
  'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama', 'Papua New Guinea',
  'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar', 'Romania',
  'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Samoa', 'San Marino',
  'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles',
  'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands',
  'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka',
  'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan',
  'Tanzania', 'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago',
  'Tunisia', 'Turkey', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine',
  'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay',
  'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen',
  'Zambia', 'Zimbabwe'
];

function fileSizeKb(file) {
  return file ? `${(file.size / 1024).toFixed(0)} KB` : '';
}

function WebcamCapture({ onCapture, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [captured, setCaptured] = useState(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setReady(false);
  }, []);

  const startCamera = useCallback(async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play();
          setReady(true);
        };
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setError('Camera permission denied. Please allow camera access in your browser settings.');
      } else if (err.name === 'NotFoundError') {
        setError('No camera found on this device. Please upload a live photo instead.');
      } else {
        setError(`Camera error: ${err.message}`);
      }
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  function takeSnapshot() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    setCaptured(canvas.toDataURL('image/jpeg', 0.92));
  }

  function usePhoto() {
    if (!captured) return;
    const byteString = atob(captured.split(',')[1]);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const file = new File([blob], `live-photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
    stopCamera();
    onCapture(file, captured);
  }

  function handleCancel() {
    stopCamera();
    onCancel();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--glass-2)', border: '1px solid var(--rule-soft)', borderTop: '3px double var(--ink)', padding: '28px', width: '600px', maxWidth: '95vw', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, color: 'var(--text, #fff)', fontSize: '17px', fontWeight: 700 }}>Live Photo Capture</h3>
          <button type="button" onClick={handleCancel} style={{ background: 'none', border: 'none', color: 'var(--text-muted, #888)', fontSize: 'var(--fs-3xl)', cursor: 'pointer', lineHeight: 1 }}>x</button>
        </div>

        {error ? (
          <div style={{ background: 'color-mix(in srgb, var(--loss) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--loss) 40%, transparent)', padding: 'var(--space-4)', color: 'var(--loss)', fontSize: 'var(--fs-md)', lineHeight: 1.6 }}>
            {error}
          </div>
        ) : (
          <>
            <div style={{ position: 'relative', overflow: 'hidden', background: '#000', aspectRatio: '16/9' }}>
              {!captured ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', display: ready ? 'block' : 'none' }}
                />
              ) : (
                <img src={captured} alt="Captured live selfie" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              )}
              {!ready && !captured && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', gap: 'var(--space-3)' }}>
                  <div style={{ width: '32px', height: '32px', border: '3px solid var(--rule)', borderTopColor: 'var(--ink)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ fontSize: 'var(--fs-base)' }}>Starting camera...</span>
                </div>
              )}
            </div>

            <p style={{ margin: 0, fontSize: 'var(--fs-base)', color: 'var(--text-muted, #888)', textAlign: 'center', lineHeight: 1.6 }}>
              Hold your government ID next to your face and make sure both your face and document are readable.
            </p>

            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              {!captured ? (
                <>
                  <button type="button" onClick={takeSnapshot} disabled={!ready} style={{ flex: 1, padding: 'var(--space-3-5)', fontSize: '15px', fontWeight: 700, cursor: ready ? 'pointer' : 'not-allowed', background: ready ? 'var(--ink)' : 'var(--rule)', border: 'none', color: 'var(--paper)', opacity: ready ? 1 : 0.5 }}>
                    Capture Photo
                  </button>
                  <button type="button" onClick={handleCancel} style={{ padding: 'var(--space-3-5) var(--space-5)', background: 'transparent', border: '1px solid var(--navy-border, rgba(255,255,255,0.1))', color: 'var(--text-muted, #888)', cursor: 'pointer', fontSize: 'var(--fs-md)' }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={usePhoto} style={{ flex: 1, padding: 'var(--space-3-5)', fontSize: '15px', fontWeight: 700, cursor: 'pointer', background: 'var(--gain)', border: 'none', color: 'var(--paper)' }}>
                    Use This Photo
                  </button>
                  <button type="button" onClick={() => setCaptured(null)} style={{ padding: 'var(--space-3-5) var(--space-5)', background: 'transparent', border: '1px solid var(--navy-border, rgba(255,255,255,0.1))', color: 'var(--text-muted, #888)', cursor: 'pointer', fontSize: 'var(--fs-md)' }}>
                    Retake
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function KYCUploadForm({
  onSubmit,
  country,
  setCountry,
  documentType,
  setDocumentType,
  documentNumber,
  setDocumentNumber,
  idDocument,
  setIdDocument,
  idDocumentBack,
  setIdDocumentBack,
  selfie,
  setSelfie,
  uploading
}) {
  const [idError, setIdError] = useState('');
  const [idBackError, setIdBackError] = useState('');
  const [selfieError, setSelfieError] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [selfiePreview, setSelfiePreview] = useState(null);

  function handleIdChange(event, side = 'front') {
    const file = event.target.files[0];
    const setError = side === 'back' ? setIdBackError : setIdError;
    const setFile = side === 'back' ? setIdDocumentBack : setIdDocument;
    const label = side === 'back' ? 'ID back document' : 'ID front document';
    if (!file) return;
    if (!ALLOWED_ID_TYPES.includes(file.type)) {
      setError(`${label} must be JPG, PNG, or PDF`);
      setFile(null);
      event.target.value = '';
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(`${label} must be under 5MB`);
      setFile(null);
      event.target.value = '';
      return;
    }
    setError('');
    setFile(file);
  }

  function handleSelfieChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!ALLOWED_SELFIE_TYPES.includes(file.type)) {
      setSelfieError('Live photo must be JPG or PNG');
      setSelfie(null);
      setSelfiePreview(null);
      event.target.value = '';
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelfieError('Live photo must be under 5MB');
      setSelfie(null);
      setSelfiePreview(null);
      event.target.value = '';
      return;
    }
    setSelfieError('');
    setSelfie(file);
    setSelfiePreview(null);
  }

  function handleCameraCapture(file, dataUrl) {
    setSelfieError('');
    setSelfie(file);
    setSelfiePreview(dataUrl);
    setShowCamera(false);
  }

  const canSubmit = Boolean(
    country?.trim() &&
    documentType &&
    documentNumber?.trim() &&
    idDocument &&
    idDocumentBack &&
    selfie &&
    !idError &&
    !idBackError &&
    !selfieError
  );

  function renderUploadBox({ inputId, label, helper, file, error, accept, onChange }) {
    return (
      <div>
        <label htmlFor={inputId}>{label}</label>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)', lineHeight: 1.5 }}>
          {helper}
        </p>
        <div
          className="kyc-upload-box"
          style={{
            border: `1.5px dashed ${error ? 'var(--red)' : 'var(--border)'}`,
            minHeight: '150px',
            padding: 'var(--space-5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            cursor: 'pointer',
            background: file ? 'color-mix(in srgb, var(--gain) 8%, transparent)' : 'var(--glass)',
            transition: 'border-color 0.2s ease, background 0.2s ease, transform 0.2s ease'
          }}
          onClick={() => document.getElementById(inputId)?.click()}
        >
          {file ? (
            <div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--accent-green)', fontWeight: 800, letterSpacing: '0.08em', marginBottom: 'var(--space-2)' }}>UPLOADED</div>
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--text-primary)', wordBreak: 'break-word' }}>{file.name}</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1-5)' }}>{fileSizeKb(file)}</div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 'var(--fs-5xl)', lineHeight: 1, marginBottom: 'var(--space-2-5)', color: 'var(--accent)' }}>+</div>
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--text-secondary)', fontWeight: 700 }}>Upload file</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1-5)' }}>JPG, PNG or PDF - max 5MB</div>
            </div>
          )}
        </div>
        {error && <p style={{ color: 'var(--red)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-1-5)' }}>{error}</p>}
        <input id={inputId} type="file" accept={accept} style={{ display: 'none' }} onChange={onChange} />
      </div>
    );
  }

  return (
    <>
      {showCamera && (
        <WebcamCapture
          onCapture={handleCameraCapture}
          onCancel={() => setShowCamera(false)}
        />
      )}

      <Card>
        <h3 style={{ color: 'var(--accent)', marginBottom: 'var(--space-2)' }}>Submit your documents</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-md)', marginBottom: 'var(--space-6)' }}>
          Country, government ID details, ID document, and a live photo — all reviewed by admin.
        </p>

        <form onSubmit={onSubmit}>
          <div style={{ display: 'grid', gap: 'var(--space-3-5)', marginBottom: '22px' }}>
            <div>
              <label htmlFor="kyc_country">Country of Residence</label>
              <select
                id="kyc_country"
                className="select-field"
                value={country || ''}
                onChange={(event) => setCountry(event.target.value)}
                required
              >
                <option value="">Select your country</option>
                {COUNTRIES.map((countryName) => (
                  <option key={countryName} value={countryName}>{countryName}</option>
                ))}
              </select>
            </div>

            <div className="grid-2 kyc-upload-grid">
              <div>
                <label htmlFor="kyc_document_type">Document Type</label>
                <select
                  id="kyc_document_type"
                  className="select-field"
                  value={documentType || 'passport'}
                  onChange={(event) => setDocumentType(event.target.value)}
                  required
                >
                  <option value="passport">Passport</option>
                  <option value="national_id">National ID</option>
                  <option value="aadhaar">Aadhaar</option>
                  <option value="drivers_license">Driver's License</option>
                  <option value="residence_permit">Residence Permit</option>
                </select>
              </div>
              <div>
                <label htmlFor="kyc_document_number">Document Number</label>
                <input
                  id="kyc_document_number"
                  className="input-field"
                  value={documentNumber || ''}
                  onChange={(event) => setDocumentNumber(event.target.value)}
                  placeholder="Enter ID / Aadhaar / Passport number"
                  required
                  minLength={4}
                  maxLength={64}
                />
              </div>
            </div>
          </div>

          <div className="grid-2 kyc-upload-grid">
            {renderUploadBox({
              inputId: 'id_doc_front_input',
              label: 'ID Document Front',
              helper: 'Upload the front side of your passport, Aadhaar, national ID, license, or residence permit.',
              file: idDocument,
              error: idError,
              accept: '.jpg,.jpeg,.png,.pdf',
              onChange: (event) => handleIdChange(event, 'front')
            })}

            {renderUploadBox({
              inputId: 'id_doc_back_input',
              label: 'ID Document Back',
              helper: 'Upload the back side of the same document. If your passport has one ID page, upload that page again.',
              file: idDocumentBack,
              error: idBackError,
              accept: '.jpg,.jpeg,.png,.pdf',
              onChange: (event) => handleIdChange(event, 'back')
            })}
          </div>

          <div className="grid-2 kyc-upload-grid" style={{ marginTop: 'var(--space-4)' }}>
            <div>
              <label htmlFor="selfie_input">Live Photo / Selfie</label>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
                Use camera or upload a clear selfie with your ID.
              </p>

              <div
                style={{
                  border: `2px dashed ${selfieError ? 'var(--red)' : 'var(--navy-border)'}`,
                  overflow: 'hidden',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: selfie ? 'color-mix(in srgb, var(--gain) 10%, transparent)' : 'var(--glass)',
                  transition: 'all 0.2s',
                  position: 'relative'
                }}
                onClick={() => !selfiePreview && document.getElementById('selfie_input').click()}
              >
                {selfiePreview ? (
                  <div style={{ position: 'relative' }}>
                    <img src={selfiePreview} alt="Live photo preview" style={{ width: '100%', maxHeight: '160px', objectFit: 'cover', display: 'block' }} />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelfie(null);
                        setSelfiePreview(null);
                      }}
                      style={{ position: 'absolute', top: '6px', right: '6px', background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%', width: '28px', height: '28px', color: '#fff', cursor: 'pointer', fontSize: 'var(--fs-md)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      x
                    </button>
                    <div style={{ padding: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--green-light)' }}>
                      {selfie?.name} - {fileSizeKb(selfie)}
                    </div>
                  </div>
                ) : selfie ? (
                  <div style={{ padding: 'var(--space-5)' }}>
                    <div style={{ fontSize: 'var(--fs-4xl)', marginBottom: 'var(--space-2)' }}>IMG</div>
                    <div style={{ fontSize: 'var(--fs-base)', color: 'var(--green-light)' }}>{selfie.name}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>{fileSizeKb(selfie)}</div>
                  </div>
                ) : (
                  <div style={{ padding: 'var(--space-5)' }}>
                    <div style={{ fontSize: 'var(--fs-4xl)', marginBottom: 'var(--space-2)' }}>+</div>
                    <div style={{ fontSize: 'var(--fs-base)', color: 'var(--text-muted)' }}>Click to upload live photo</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)' }}>JPG or PNG - max 5MB</div>
                  </div>
                )}
              </div>

              {selfieError && <p style={{ color: 'var(--red)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-1-5)' }}>{selfieError}</p>}

              <button
                type="button"
                onClick={() => setShowCamera(true)}
                style={{ marginTop: 'var(--space-2)', width: '100%', padding: 'var(--space-2-5)', background: 'transparent', border: '1px solid var(--rule)', color: 'var(--accent)', fontSize: 'var(--fs-base)', fontWeight: 600, cursor: 'pointer', transition: 'border-color 0.2s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)' }}
              >
                Use Live Camera Instead
              </button>

              <input id="selfie_input" type="file" accept=".jpg,.jpeg,.png" style={{ display: 'none' }} onChange={handleSelfieChange} />
            </div>
          </div>

          <div style={{ marginTop: 'var(--space-5)', padding: 'var(--space-4)', background: 'var(--glass)', border: '1px solid var(--rule-soft)', marginBottom: 'var(--space-5)' }}>
            <p style={{ margin: 0, fontSize: 'var(--fs-base)', color: 'var(--text-muted)' }}>
              Your documents are stored securely and only used for identity verification. Admin can review the submitted details, ID document, and live photo.
            </p>
          </div>

          <button className="btn btn-accent" type="submit" style={{ padding: 'var(--space-3) var(--space-7)' }} disabled={uploading || !canSubmit}>
            {uploading ? 'Uploading...' : 'Submit for Verification'}
          </button>
        </form>
      </Card>
    </>
  );
}
