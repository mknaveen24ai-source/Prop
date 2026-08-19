/**
 * Social sharing for certificates.
 *
 * An honest note on what the web platform actually allows, because three of the
 * four targets here work differently:
 *
 *   X and LinkedIn  — real share intents. A normal link opens their composer
 *                     pre-filled. These genuinely work.
 *   Discord         — has no web share intent at all. The best available
 *                     behaviour is to copy the caption and link so the trader
 *                     can paste it into a server.
 *   Instagram       — has no web intent either, and Stories cannot be posted
 *                     from a browser by anyone. On mobile, Web Share Level 2
 *                     (navigator.share with a File) surfaces Instagram in the
 *                     OS sheet, which is as close as the platform gets. On
 *                     desktop it degrades to downloading the image and copying
 *                     the caption.
 *
 * The UI labels each button for what it really does rather than implying a
 * one-click post that cannot exist.
 */

/** Pre-written celebratory captions, one per certificate kind. */
const CAPTIONS = {
  funded: (certificate) =>
    `I'm officially a ${certificate.title}! Passed the evaluation and I'm now trading funded capital. Verify it here:`,
  phase_passed: (certificate) =>
    `${certificate.title} — cleared. One step closer to a funded account. Verified here:`,
  payout: (certificate) =>
    `Just got paid. ${certificate.title} received and verified. Proof here:`,
  custom: (certificate) =>
    `Earned my ${certificate.title}. Verified here:`
}

export function buildCaption(certificate) {
  const build = CAPTIONS[certificate?.kind] || CAPTIONS.custom
  return build(certificate || {})
}

export function verifyUrlFor(certificate) {
  if (certificate?.verify_url) return certificate.verify_url
  // Fall back to the current origin so sharing still works if the server did
  // not supply an absolute URL.
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/verify/${encodeURIComponent(certificate?.public_id || '')}`
}

export function twitterShareUrl(certificate) {
  const params = new URLSearchParams({ text: buildCaption(certificate), url: verifyUrlFor(certificate) })
  return `https://twitter.com/intent/tweet?${params.toString()}`
}

export function linkedInShareUrl(certificate) {
  const params = new URLSearchParams({ url: verifyUrlFor(certificate) })
  return `https://www.linkedin.com/sharing/share-offsite/?${params.toString()}`
}

/**
 * Clipboard write with a fallback for insecure origins and older browsers,
 * matching the affiliate-link copy behaviour already in the dashboard.
 * Returns true on success so the caller can show a real result rather than
 * assuming one.
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the textarea path below.
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

export function shareTextFor(certificate) {
  return `${buildCaption(certificate)} ${verifyUrlFor(certificate)}`
}

/** True when this browser can share an actual image file (Web Share Level 2). */
export function canShareFiles() {
  return typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function'
}

/**
 * Instagram Stories path. Tries the native share sheet with the certificate
 * image attached; returns a result describing what actually happened so the
 * caller can tell the trader the truth.
 *
 * @returns {Promise<{ shared: boolean, reason?: 'unsupported'|'cancelled'|'failed' }>}
 */
export async function shareImageNatively(certificate, imageUrl) {
  if (!canShareFiles()) return { shared: false, reason: 'unsupported' }

  try {
    const response = await fetch(imageUrl, { credentials: 'include' })
    if (!response.ok) return { shared: false, reason: 'failed' }

    const blob = await response.blob()
    const file = new File([blob], `certificate-${certificate.public_id}.png`, { type: 'image/png' })

    if (!navigator.canShare({ files: [file] })) return { shared: false, reason: 'unsupported' }

    await navigator.share({
      files: [file],
      title: certificate.title,
      text: shareTextFor(certificate)
    })
    return { shared: true }
  } catch (error) {
    // A user dismissing the sheet throws AbortError; that is not a failure.
    return { shared: false, reason: error?.name === 'AbortError' ? 'cancelled' : 'failed' }
  }
}

/** Triggers a browser download of a URL without navigating away from the page. */
export function triggerDownload(url, filename) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
