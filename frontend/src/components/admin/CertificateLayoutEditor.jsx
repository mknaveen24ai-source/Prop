import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Visual placement editor for certificate fields.
 *
 * The admin uploads their own artwork and drags each dynamic field onto it.
 * Positions are stored as FRACTIONS of the canvas, never pixels, which is what
 * lets the browser show the artwork at whatever width fits while the server
 * renders it at 3000px+ from the same numbers.
 *
 * Anchor semantics must match services/certificateLayout.js exactly:
 *   - text: (x, y) is the anchor — left/centre/right per `align` — and y is the
 *     BASELINE, so the chip is drawn sitting on the point rather than centred
 *     on it.
 *   - qr: (x, y) is the CENTRE of the block.
 *
 * Dragging is not the only way to place a field. Every chip is focusable and
 * arrow-nudgeable, and the properties panel carries numeric inputs — a
 * drag-only editor would be unusable by keyboard, the same gap the draggable
 * dashboard blocks had to fix with an explicit reposition control.
 */

const NUDGE = 0.005
const NUDGE_LARGE = 0.05

export default function CertificateLayoutEditor({
  imageUrl,
  canvasWidth,
  canvasHeight,
  layout,
  fields,
  onChange,
  selectedKey,
  onSelect
}) {
  const canvasRef = useRef(null)
  const draggingRef = useRef(null)
  const [guides, setGuides] = useState({ x: false, y: false })

  const aspect = canvasHeight && canvasWidth ? (canvasHeight / canvasWidth) * 100 : 68.75

  const updateField = useCallback((key, patch) => {
    onChange({
      ...layout,
      fields: { ...layout.fields, [key]: { ...layout.fields[key], ...patch } }
    })
  }, [layout, onChange])

  const pointFromEvent = useCallback((event) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height
    }
  }, [])

  useEffect(() => {
    function onPointerMove(event) {
      const key = draggingRef.current
      if (!key) return
      const point = pointFromEvent(event)
      if (!point) return

      // Snap to the centre line and the vertical middle when close, so a
      // centred title actually lands on 0.5 rather than 0.497.
      let { x, y } = point
      const snapX = Math.abs(x - 0.5) < 0.012
      const snapY = Math.abs(y - 0.5) < 0.012
      if (snapX) x = 0.5
      if (snapY) y = 0.5
      setGuides({ x: snapX, y: snapY })

      updateField(key, {
        x: Math.round(Math.min(1.25, Math.max(-0.25, x)) * 1000) / 1000,
        y: Math.round(Math.min(1.25, Math.max(-0.25, y)) * 1000) / 1000
      })
    }

    function onPointerUp() {
      draggingRef.current = null
      setGuides({ x: false, y: false })
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [pointFromEvent, updateField])

  function handleKeyDown(event, key) {
    const step = event.shiftKey ? NUDGE_LARGE : NUDGE
    const field = layout.fields[key]
    const moves = {
      ArrowLeft: { x: field.x - step },
      ArrowRight: { x: field.x + step },
      ArrowUp: { y: field.y - step },
      ArrowDown: { y: field.y + step }
    }
    if (!moves[event.key]) return
    event.preventDefault()
    const patch = moves[event.key]
    updateField(key, {
      x: Math.round(Math.min(1.25, Math.max(-0.25, patch.x ?? field.x)) * 1000) / 1000,
      y: Math.round(Math.min(1.25, Math.max(-0.25, patch.y ?? field.y)) * 1000) / 1000
    })
  }

  return (
    <div
      ref={canvasRef}
      style={{
        position: 'relative', width: '100%', paddingTop: `${aspect}%`,
        border: '1px solid var(--admin-border)', background: '#0C0B0A',
        overflow: 'hidden', touchAction: 'none', userSelect: 'none'
      }}
    >
      <img
        src={imageUrl}
        alt="Certificate template artwork"
        draggable={false}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />

      {guides.x && <Guide vertical />}
      {guides.y && <Guide />}

      {fields.map((def) => {
        const field = layout.fields[def.key]
        if (!field || !field.visible) return null

        const isQr = def.type === 'qr'
        const isSelected = selectedKey === def.key
        const anchorShift = isQr
          ? '-50%'
          : ({ left: '0%', center: '-50%', right: '-100%' }[field.align] || '-50%')

        return (
          <button
            key={def.key}
            type="button"
            onPointerDown={(event) => {
              event.preventDefault()
              draggingRef.current = def.key
              onSelect(def.key)
            }}
            onKeyDown={(event) => handleKeyDown(event, def.key)}
            onFocus={() => onSelect(def.key)}
            aria-label={`${def.label} at ${Math.round(field.x * 100)}% across, ${Math.round(field.y * 100)}% down. Arrow keys to move.`}
            style={{
              position: 'absolute',
              left: `${field.x * 100}%`,
              top: `${field.y * 100}%`,
              // Text sits ON its baseline; the QR block is centred on its point.
              transform: `translate(${anchorShift}, ${isQr ? '-50%' : '-100%'})`,
              width: isQr ? `${field.size * (canvasHeight / canvasWidth) * 100}%` : 'auto',
              height: isQr ? `${field.size * 100}%` : 'auto',
              padding: isQr ? 0 : '2px 6px',
              cursor: 'grab',
              whiteSpace: 'nowrap',
              background: isQr ? 'rgba(232,180,0,0.15)' : (isSelected ? 'rgba(232,180,0,0.9)' : 'rgba(12,11,10,0.75)'),
              color: isSelected && !isQr ? '#0C0B0A' : '#EDE9E0',
              border: `1px ${isSelected ? 'solid' : 'dashed'} ${isSelected ? '#F5C518' : 'rgba(232,180,0,0.6)'}`,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              zIndex: isSelected ? 3 : 2
            }}
          >
            {isQr ? '' : def.label}
          </button>
        )
      })}
    </div>
  )
}

function Guide({ vertical = false }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: vertical ? '50%' : 0,
        top: vertical ? 0 : '50%',
        width: vertical ? 1 : '100%',
        height: vertical ? '100%' : 1,
        background: '#F5C518',
        opacity: 0.7,
        zIndex: 1
      }}
    />
  )
}
