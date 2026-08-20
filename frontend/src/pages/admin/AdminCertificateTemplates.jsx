import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import CertificateLayoutEditor from '../../components/admin/CertificateLayoutEditor'
import { apiUrl } from '../../config/apiBase'

/**
 * AdminCertificateTemplates — upload your own certificate design and place the
 * dynamic fields on it.
 *
 * Two things worth knowing before editing this page:
 *
 * 1. TEMPLATES ARE IMMUTABLE VERSIONS. Saving a layout does not mutate the
 *    template — it inserts version N+1 and deactivates the old one. Existing
 *    certificates pinned their version at issue time and keep rendering exactly
 *    as they were downloaded and shared. That is intentional, not a bug.
 *
 * 2. THE PREVIEW IS SERVER-RENDERED. The editor canvas is HTML and the real
 *    output is resvg; the two will never agree perfectly on text metrics. The
 *    Preview button round-trips through the actual renderer, so it is the
 *    ground truth — the canvas is only for placement.
 */

const KIND_LABELS = {
  '': 'Default (all certificates)',
  phase_passed: 'Challenge Passed',
  funded: 'Funded Trader',
  payout: 'Profit Payout',
  custom: 'Custom Award'
}

export default function AdminCertificateTemplates() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()
  const fileInputRef = useRef(null)

  const [schema, setSchema] = useState(null)
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [layout, setLayout] = useState(null)
  const [selectedField, setSelectedField] = useState('recipient_name')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadKind, setUploadKind] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewing, setPreviewing] = useState(false)

  const selected = templates.find((t) => String(t.id) === String(selectedId)) || null

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [schemaRes, listRes] = await Promise.all([
        adminAxios.get('/api/admin/certificates/templates/schema'),
        adminAxios.get('/api/admin/certificates/templates')
      ])
      setSchema(schemaRes.data)
      setTemplates(listRes.data.templates || [])
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load certificate templates')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios])

  useEffect(() => { load() }, [load])

  // Selecting a template loads its layout into local editing state.
  useEffect(() => {
    if (!selected) { setLayout(null); return }
    setLayout(selected.layout && selected.layout.fields ? selected.layout : (schema?.defaultLayout || null))
    setDirty(false)
    setPreviewUrl('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, templates])

  // Revoke the last object URL so a long editing session does not leak blobs.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  async function handleUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('template', file)
      form.append('name', file.name)
      if (uploadKind) form.append('kind', uploadKind)

      const res = await adminAxios.post('/api/admin/certificates/templates', form)
      toast.success('Template uploaded — now place the fields')
      await load()
      setSelectedId(res.data.template.id)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not upload that template')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function saveLayout() {
    setSaving(true)
    try {
      const res = await adminAxios.put(`/api/admin/certificates/templates/${selected.id}/layout`, { layout })
      toast.success(`Saved as version ${res.data.template.version}`)
      await load()
      setSelectedId(res.data.template.id)
      setDirty(false)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save that layout')
    } finally {
      setSaving(false)
    }
  }

  async function renderPreview() {
    setPreviewing(true)
    try {
      // Posts the UNSAVED layout so the admin can check placement before
      // committing a new version.
      const res = await adminAxios.post(
        `/api/admin/certificates/templates/${selected.id}/preview`,
        { layout },
        { responseType: 'blob' }
      )
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(URL.createObjectURL(res.data))
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not render a preview')
    } finally {
      setPreviewing(false)
    }
  }

  async function removeTemplate(template) {
    if (!window.confirm(`Delete "${template.name}" (v${template.version})?`)) return
    try {
      await adminAxios.delete(`/api/admin/certificates/templates/${template.id}`)
      toast.success('Template deleted')
      if (String(template.id) === String(selectedId)) setSelectedId(null)
      load()
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not delete that template')
    }
  }

  function updateSelectedField(patch) {
    setLayout((current) => ({
      ...current,
      fields: { ...current.fields, [selectedField]: { ...current.fields[selectedField], ...patch } }
    }))
    setDirty(true)
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--admin-text-muted)' }}>Loading templates…</div>

  const fieldDef = schema?.fields.find((f) => f.key === selectedField)
  const field = layout?.fields?.[selectedField]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">Certificate Templates</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 13, marginBottom: 20, maxWidth: 720 }}>
            Upload your own certificate design, then drag the trader name, title, date, ID and QR code onto it.
            Certificates already issued keep the design they were issued with — saving creates a new version for future awards.
            With no template uploaded, a built-in dark and gold design is used.
          </p>
        </div>
        <Link to="/admin/certificates" className="admin-btn-secondary" style={{ textDecoration: 'none', height: 'fit-content' }}>
          Issued certificates
        </Link>
      </div>

      <div style={{
        border: '1px solid var(--admin-border)', padding: 16, marginBottom: 24,
        display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap'
      }}>
        <div>
          <label className="admin-label" htmlFor="template-kind">Applies to</label>
          <select id="template-kind" className="admin-input" style={{ minWidth: 220 }}
            value={uploadKind} onChange={(e) => setUploadKind(e.target.value)}>
            {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 260px' }}>
          <label className="admin-label" htmlFor="template-file">Design file</label>
          <input id="template-file" ref={fileInputRef} className="admin-input" type="file"
            accept="image/png,image/jpeg" onChange={handleUpload} disabled={uploading} />
        </div>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 11, margin: 0, flex: '1 1 100%' }}>
          PNG or JPEG, at least {schema?.constraints.minWidth}×{schema?.constraints.minHeight}px,
          up to {Math.round((schema?.constraints.maxUploadBytes || 0) / 1024 / 1024)}MB.
          Landscape designs around 3000×2000px reproduce best in print.
          {uploading && ' · Uploading…'}
        </p>
      </div>

      <div className="ui-split" style={{ '--split': 'minmax(0, 2fr) minmax(0, 1fr)', '--split-gap': '24px' }}>
        <div>
          {templates.length === 0 && (
            <div style={{ border: '1px dashed var(--admin-border)', padding: 40, textAlign: 'center', color: 'var(--admin-text-muted)' }}>
              No templates yet. Certificates currently use the built-in design.
            </div>
          )}

          {templates.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => setSelectedId(template.id)}
                  style={{
                    padding: 'var(--space-2) var(--space-3)', cursor: 'pointer', textAlign: 'left',
                    background: String(template.id) === String(selectedId) ? 'var(--admin-accent)' : 'transparent',
                    color: String(template.id) === String(selectedId) ? 'var(--paper)' : 'var(--admin-text-muted)',
                    border: '1px solid var(--admin-border)', fontFamily: 'var(--font-mono)', fontSize: 11
                  }}
                >
                  {KIND_LABELS[template.kind || '']} · v{template.version}
                  {template.is_active ? ' · ACTIVE' : ''}
                  <span style={{ display: 'block', opacity: 0.75 }}>{template.certificate_count} issued</span>
                </button>
              ))}
            </div>
          )}

          {selected && layout && schema && (
            <CertificateLayoutEditor
              imageUrl={apiUrl(`/api/admin/certificates/templates/${selected.id}/image`)}
              canvasWidth={selected.image_width}
              canvasHeight={selected.image_height}
              layout={layout}
              fields={schema.fields}
              selectedKey={selectedField}
              onSelect={setSelectedField}
              onChange={(next) => { setLayout(next); setDirty(true) }}
            />
          )}

          {selected && (
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button className="admin-btn-primary" onClick={saveLayout} disabled={!dirty || saving}>
                {saving ? 'Saving…' : dirty ? 'Save as new version' : 'Saved'}
              </button>
              <button className="admin-btn-secondary" onClick={renderPreview} disabled={previewing}>
                {previewing ? 'Rendering…' : 'Preview (server render)'}
              </button>
              <button className="admin-btn-secondary" onClick={() => removeTemplate(selected)}>Delete</button>
            </div>
          )}

          {previewUrl && (
            <div style={{ marginTop: 24 }}>
              <h3 className="admin-h3">Server preview</h3>
              <p style={{ color: 'var(--admin-text-muted)', fontSize: 12 }}>
                Rendered by the same code that produces real certificates, with sample data. This is what traders will actually receive.
              </p>
              <img src={previewUrl} alt="Server-rendered certificate preview"
                style={{ width: '100%', border: '1px solid var(--admin-border)' }} />
            </div>
          )}
        </div>

        <div>
          {selected && field && fieldDef ? (
            <div style={{ border: '1px solid var(--admin-border)', padding: 16, position: 'sticky', top: 16 }}>
              <h3 className="admin-h3" style={{ marginTop: 0 }}>{fieldDef.label}</h3>

              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {schema.fields.map((def) => (
                  <button
                    key={def.key}
                    onClick={() => setSelectedField(def.key)}
                    style={{
                      padding: 'var(--space-1) var(--space-2)', fontSize: 10, fontFamily: 'var(--font-mono)', cursor: 'pointer',
                      background: def.key === selectedField ? 'var(--admin-accent)' : 'transparent',
                      color: def.key === selectedField ? 'var(--paper)' : 'var(--admin-text-muted)',
                      border: '1px solid var(--admin-border)',
                      opacity: layout.fields[def.key]?.visible ? 1 : 0.45
                    }}
                  >
                    {def.label}
                  </button>
                ))}
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
                <input type="checkbox" checked={field.visible}
                  onChange={(e) => updateSelectedField({ visible: e.target.checked })} />
                Show this field
              </label>

              <NumberRow label="X (across)" value={field.x} step={0.005} onChange={(v) => updateSelectedField({ x: v })} />
              <NumberRow label="Y (down)" value={field.y} step={0.005} onChange={(v) => updateSelectedField({ y: v })} />
              <NumberRow label="Size" value={field.size} step={0.002} onChange={(v) => updateSelectedField({ size: v })} />

              {fieldDef.type === 'text' && (
                <>
                  <label className="admin-label" htmlFor="field-font">Font</label>
                  <select id="field-font" className="admin-input" value={field.font}
                    onChange={(e) => updateSelectedField({ font: e.target.value })}>
                    {Object.entries(schema.fonts).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                  </select>

                  <label className="admin-label" htmlFor="field-weight">Weight</label>
                  <select id="field-weight" className="admin-input" value={field.weight}
                    onChange={(e) => updateSelectedField({ weight: Number(e.target.value) })}>
                    {schema.weights.map((w) => <option key={w} value={w}>{w === 700 ? 'Bold' : 'Regular'}</option>)}
                  </select>

                  <label className="admin-label" htmlFor="field-align">Align</label>
                  <select id="field-align" className="admin-input" value={field.align}
                    onChange={(e) => updateSelectedField({ align: e.target.value })}>
                    {schema.alignments.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>

                  <label className="admin-label" htmlFor="field-color">Colour</label>
                  <input id="field-color" className="admin-input" type="color" value={field.color}
                    onChange={(e) => updateSelectedField({ color: e.target.value.toUpperCase() })} />

                  <NumberRow label="Letter spacing" value={field.letterSpacing} step={0.002}
                    onChange={(v) => updateSelectedField({ letterSpacing: v })} />

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
                    <input type="checkbox" checked={field.uppercase}
                      onChange={(e) => updateSelectedField({ uppercase: e.target.checked })} />
                    Uppercase
                  </label>
                </>
              )}

              <p style={{ color: 'var(--admin-text-muted)', fontSize: 11, marginTop: 16, lineHeight: 1.5 }}>
                Drag the field on the canvas, or focus it and use the arrow keys (hold Shift for larger steps).
                Values are fractions of the canvas, so the layout holds at any output size.
              </p>
            </div>
          ) : (
            <div style={{ border: '1px dashed var(--admin-border)', padding: 24, color: 'var(--admin-text-muted)', fontSize: 13 }}>
              Select a template to edit its field placement.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NumberRow({ label, value, step, onChange }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label className="admin-label">{label}</label>
      <input
        className="admin-input"
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
    </div>
  )
}
