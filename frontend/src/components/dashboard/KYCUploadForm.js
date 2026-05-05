import React, { useState, useRef, useEffect, useCallback } from 'react';

const ALLOWED_ID_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
const ALLOWED_SELFIE_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// ── Live webcam capture component ────────────────────────────────────────────
function WebcamCapture({ onCapture, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [captured, setCaptured] = useState(null); // base64 preview

  const startCamera = useCallback(async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
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
        setError('No camera found on this device. Please upload a photo instead.');
      } else {
        setError(`Camera error: ${err.message}`);
      }
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setReady(false);
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
    // Mirror horizontally (natural selfie orientation)
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    setCaptured(dataUrl);
  }

  function retake() {
    setCaptured(null);
  }

  function usePhoto() {
    if (!captured) return;
    // Convert base64 → Blob → File
    const byteString = atob(captured.split(',')[1]);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const file = new File([blob], `selfie-${Date.now()}.jpg`, { type: 'image/jpeg' });
    stopCamera();
    onCapture(file, captured);
  }

  function handleCancel() {
    stopCamera();
    onCancel();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-base, #0f1117)', borderRadius: '16px', padding: '28px', width: '600px', maxWidth: '95vw', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 24px 80px rgba(0,0,0,0.8)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, color: 'var(--text, #fff)', fontSize: '17px', fontWeight: 700 }}>📸 Take Selfie with ID</h3>
          <button onClick={handleCancel} style={{ background: 'none', border: 'none', color: 'var(--text-muted, #888)', fontSize: '22px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {error ? (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', padding: '16px', color: '#ef4444', fontSize: '14px', lineHeight: 1.6 }}>
            {error}
          </div>
        ) : (
          <>
            {/* Video / captured preview */}
            <div style={{ position: 'relative', borderRadius: '10px', overflow: 'hidden', background: '#000', aspectRatio: '16/9' }}>
              {!captured ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', display: ready ? 'block' : 'none' }}
                />
              ) : (
                <img src={captured} alt="Captured selfie" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              )}
              {!ready && !captured && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#888', gap: '12px' }}>
                  <div style={{ width: '32px', height: '32px', border: '3px solid rgba(41,98,255,0.4)', borderTopColor: '#2962ff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ fontSize: '13px' }}>Starting camera…</span>
                </div>
              )}
              {/* Face guide overlay */}
              {!captured && ready && (
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: '160px', height: '200px', border: '2px dashed rgba(41,98,255,0.6)', borderRadius: '50%', boxShadow: '0 0 0 9999px rgba(0,0,0,0.25)' }} />
                </div>
              )}
            </div>

            {/* Instruction */}
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted, #888)', textAlign: 'center', lineHeight: 1.6 }}>
              Hold your <strong>ID document</strong> next to your face and look at the camera.
            </p>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '12px' }}>
              {!captured ? (
                <>
                  <button
                    onClick={takeSnapshot}
                    disabled={!ready}
                    style={{
                      flex: 1, padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 700, cursor: ready ? 'pointer' : 'not-allowed',
                      background: ready ? 'linear-gradient(135deg, #2962ff, #1e4bd8)' : '#333',
                      border: 'none', color: '#fff', transition: 'opacity 0.2s', opacity: ready ? 1 : 0.5
                    }}
                  >
                    📸 Capture
                  </button>
                  <button onClick={handleCancel} style={{ padding: '14px 20px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--navy-border, rgba(255,255,255,0.1))', color: 'var(--text-muted, #888)', cursor: 'pointer', fontSize: '14px' }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button onClick={usePhoto} style={{ flex: 1, padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 700, cursor: 'pointer', background: 'linear-gradient(135deg, #00c896, #00a07a)', border: 'none', color: '#fff' }}>
                    ✅ Use This Photo
                  </button>
                  <button onClick={retake} style={{ padding: '14px 20px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--navy-border, rgba(255,255,255,0.1))', color: 'var(--text-muted, #888)', cursor: 'pointer', fontSize: '14px' }}>
                    🔄 Retake
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
      {/* Canvas used for snapshot — hidden */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Main KYC Upload Form ──────────────────────────────────────────────────────
export default function KYCUploadForm({
  onSubmit,
  idDocument,
  setIdDocument,
  selfie,
  setSelfie,
  uploading,
}) {
  const [idError, setIdError] = useState('');
  const [selfieError, setSelfieError] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [selfiePreview, setSelfiePreview] = useState(null); // base64 for camera captures

  function handleIdChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!ALLOWED_ID_TYPES.includes(file.type)) {
      setIdError('ID must be JPG, PNG or PDF');
      setIdDocument(null);
      event.target.value = '';
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setIdError('ID file must be under 5MB');
      setIdDocument(null);
      event.target.value = '';
      return;
    }
    setIdError('');
    setIdDocument(file);
  }

  function handleSelfieChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!ALLOWED_SELFIE_TYPES.includes(file.type)) {
      setSelfieError('Selfie must be JPG or PNG (no PDFs)');
      setSelfie(null);
      setSelfiePreview(null);
      event.target.value = '';
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelfieError('Selfie file must be under 5MB');
      setSelfie(null);
      setSelfiePreview(null);
      event.target.value = '';
      return;
    }
    setSelfieError('');
    setSelfie(file);
    setSelfiePreview(null); // normal file upload — no base64 preview needed
  }

  function handleCameraCapture(file, dataUrl) {
    setSelfieError('');
    setSelfie(file);
    setSelfiePreview(dataUrl);
    setShowCamera(false);
  }

  return (
    <>
      {showCamera && (
        <WebcamCapture
          onCapture={handleCameraCapture}
          onCancel={() => setShowCamera(false)}
        />
      )}

      <div className="card" style={{ maxWidth: '600px' }}>
        <h3 style={{ color: 'var(--accent)', marginBottom: '8px' }}>Upload Documents</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '24px' }}>
          Upload your ID document and a selfie. ID files must be JPG, PNG or PDF under 5MB. Selfie must be JPG or PNG.
        </p>
        <form onSubmit={onSubmit}>
          <div className="grid-2 kyc-upload-grid">
            {/* ── ID Document ── */}
            <div>
              <label>ID Document</label>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Passport, National ID or Driver's License</p>
              <div
                style={{
                  border: `2px dashed ${idError ? 'var(--red)' : 'var(--navy-border)'}`,
                  borderRadius: '8px',
                  padding: '20px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: idDocument ? 'rgba(74, 74, 74, 0.12)' : 'transparent',
                  transition: 'all 0.2s',
                }}
                onClick={() => document.getElementById('id_doc_input').click()}
              >
                {idDocument ? (
                  <div>
                    <div style={{ fontSize: '24px', marginBottom: '8px' }}>DOC</div>
                    <div style={{ fontSize: '13px', color: 'var(--green-light)' }}>{idDocument.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{(idDocument.size / 1024).toFixed(0)} KB</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: '24px', marginBottom: '8px' }}>+</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Click to upload</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>JPG, PNG or PDF · max 5MB</div>
                  </div>
                )}
              </div>
              {idError && (
                <p style={{ color: 'var(--red)', fontSize: '12px', marginTop: '6px' }}>Warning: {idError}</p>
              )}
              <input id="id_doc_input" type="file" accept=".jpg,.jpeg,.png,.pdf" style={{ display: 'none' }} onChange={handleIdChange} />
            </div>

            {/* ── Selfie with ID ── */}
            <div>
              <label>Selfie with ID</label>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Hold your ID next to your face</p>

              {/* Selfie drop-zone */}
              <div
                style={{
                  border: `2px dashed ${selfieError ? 'var(--red)' : 'var(--navy-border)'}`,
                  borderRadius: '8px',
                  overflow: 'hidden',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: selfie ? 'rgba(74, 74, 74, 0.12)' : 'transparent',
                  transition: 'all 0.2s',
                  position: 'relative',
                }}
                onClick={() => !selfiePreview && document.getElementById('selfie_input').click()}
              >
                {/* Camera-captured preview */}
                {selfiePreview ? (
                  <div style={{ position: 'relative' }}>
                    <img
                      src={selfiePreview}
                      alt="Selfie preview"
                      style={{ width: '100%', maxHeight: '160px', objectFit: 'cover', display: 'block' }}
                    />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setSelfie(null); setSelfiePreview(null); }}
                      style={{
                        position: 'absolute', top: '6px', right: '6px',
                        background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%',
                        width: '28px', height: '28px', color: '#fff', cursor: 'pointer', fontSize: '14px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >×</button>
                    <div style={{ padding: '8px', fontSize: '12px', color: 'var(--green-light)' }}>
                      ✅ {selfie?.name} · {selfie ? (selfie.size / 1024).toFixed(0) : 0} KB
                    </div>
                  </div>
                ) : selfie ? (
                  <div style={{ padding: '20px' }}>
                    <div style={{ fontSize: '24px', marginBottom: '8px' }}>IMG</div>
                    <div style={{ fontSize: '13px', color: 'var(--green-light)' }}>{selfie.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{(selfie.size / 1024).toFixed(0)} KB</div>
                  </div>
                ) : (
                  <div style={{ padding: '20px' }}>
                    <div style={{ fontSize: '24px', marginBottom: '8px' }}>+</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Click to upload (JPG or PNG only)</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>max 5MB</div>
                  </div>
                )}
              </div>

              {selfieError && (
                <p style={{ color: 'var(--red)', fontSize: '12px', marginTop: '6px' }}>Warning: {selfieError}</p>
              )}

              {/* Camera button */}
              <button
                type="button"
                onClick={() => setShowCamera(true)}
                style={{
                  marginTop: '8px',
                  width: '100%',
                  padding: '10px',
                  borderRadius: '8px',
                  background: 'rgba(41,98,255,0.08)',
                  border: '1px solid rgba(41,98,255,0.3)',
                  color: 'var(--accent)',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(41,98,255,0.14)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(41,98,255,0.08)'}
              >
                📷 Use Live Camera Instead
              </button>

              <input id="selfie_input" type="file" accept=".jpg,.jpeg,.png" style={{ display: 'none' }} onChange={handleSelfieChange} />
            </div>
          </div>

          <div
            style={{
              marginTop: '20px',
              padding: '16px',
              background: 'var(--navy-card)',
              border: '1px solid var(--navy-border)',
              borderRadius: '8px',
              marginBottom: '20px',
            }}
          >
            <p style={{ margin: '0', fontSize: '13px', color: 'var(--text-muted)' }}>
              Your documents are securely stored and only used for identity verification. We accept government-issued IDs only.
            </p>
          </div>

          <button
            className="btn btn-accent"
            type="submit"
            style={{ padding: '12px 32px' }}
            disabled={uploading || !idDocument || !selfie || !!idError || !!selfieError}
          >
            {uploading ? 'Uploading...' : 'Submit for Verification'}
          </button>
        </form>
      </div>
    </>
  );
}
