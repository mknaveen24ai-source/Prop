import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Field from './Field'

/**
 * The error/hint linkage is the whole point of routing forms through Field
 * rather than hand-rolling `.input-field` markup, so it is asserted rather than
 * assumed. `getByLabelText` is used deliberately: it resolves through the
 * accessibility tree, so it only passes if the label really is associated.
 */
describe('Field', () => {
  it('associates the label with the control', () => {
    render(<Field label="Lot size" />)
    expect(screen.getByLabelText('Lot size')).toBeInTheDocument()
  })

  it('gives each instance a distinct id so two fields cannot collide', () => {
    render(
      <>
        <Field label="First" />
        <Field label="Second" />
      </>
    )
    const first = screen.getByLabelText('First')
    const second = screen.getByLabelText('Second')
    expect(first.id).not.toBe(second.id)
  })

  it('marks an invalid field and points it at the error text', () => {
    render(<Field label="Lot size" error="Must be at least 0.01" />)
    const input = screen.getByLabelText('Lot size')
    expect(input).toHaveAttribute('aria-invalid', 'true')

    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    // The id must actually resolve — a dangling aria-describedby announces
    // nothing and looks identical in the markup.
    const description = document.getElementById(describedBy)
    expect(description).not.toBeNull()
    expect(description).toHaveTextContent('Must be at least 0.01')
    expect(description).toHaveAttribute('role', 'alert')
  })

  it('is not marked invalid when there is no error', () => {
    render(<Field label="Lot size" />)
    expect(screen.getByLabelText('Lot size')).not.toHaveAttribute('aria-invalid')
  })

  it('describes the control with the hint when there is no error', () => {
    render(<Field label="API key" hint="Found under Settings" />)
    const input = screen.getByLabelText('API key')
    const describedBy = input.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy)).toHaveTextContent('Found under Settings')
  })

  it('points at the error rather than the hint when both would apply', () => {
    // The hint is not rendered while an error is showing, so describing the
    // control with it would reference an element that does not exist.
    render(<Field label="API key" hint="Found under Settings" error="Required" />)
    const input = screen.getByLabelText('API key')
    const ids = input.getAttribute('aria-describedby').split(' ')
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull()
    expect(screen.queryByText('Found under Settings')).not.toBeInTheDocument()
    expect(screen.getByText('Required')).toBeInTheDocument()
  })

  it('applies the same linkage to select and textarea', () => {
    const { rerender } = render(<Field label="Status" type="select" options={['open', 'closed']} error="Pick one" />)
    expect(screen.getByLabelText('Status')).toHaveAttribute('aria-invalid', 'true')

    rerender(<Field label="Notes" type="textarea" error="Too long" />)
    const textarea = screen.getByLabelText('Notes')
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea).toHaveAttribute('aria-invalid', 'true')
  })

  it('names the reveal toggle and reports its state', () => {
    render(<Field label="Webhook secret" secret />)
    const toggle = screen.getByRole('button', { name: 'Reveal value' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps a caller-supplied aria-describedby alongside its own', () => {
    render(
      <>
        <span id="external-note">See the docs</span>
        <Field label="Lot size" error="Required" aria-describedby="external-note" />
      </>
    )
    const ids = screen.getByLabelText('Lot size').getAttribute('aria-describedby').split(' ')
    expect(ids).toContain('external-note')
    expect(ids.length).toBe(2)
  })
})
