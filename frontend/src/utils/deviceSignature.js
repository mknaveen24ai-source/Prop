/**
 * Device signature collection.
 *
 * Gathers a browser fingerprint component vector for the account-sharing
 * detector. Sent on the X-Device-Signature header by services/api.js and parsed
 * by backend/utils/deviceSignature.js, which recomputes the composite hash
 * server-side — nothing here is trusted as-is.
 *
 * Design constraints:
 *
 *  - Every probe is individually guarded. A blocked canvas (Brave, Tor, a
 *    privacy extension) must degrade to a partial vector, never throw and never
 *    break the request it is riding on.
 *  - Computed ONCE and memoized. Canvas rendering, audio-context sampling and
 *    font metrics are not free, and this runs on the axios request interceptor
 *    which fires on every single API call.
 *  - Only stable properties. Window size, devicePixelRatio and language are
 *    deliberately excluded because they change for the same physical device;
 *    the backend's STABLE_COMPONENTS list is the authority on which ones feed
 *    the composite hash.
 *
 * The collected data is declared in the privacy policy (see PrivacyPolicy.jsx).
 */

const STORAGE_KEY = 'device_signature_v1'
const VERSION = 1

let memoized = null

function safe (fn, fallback = null) {
  try {
    const value = fn()
    return value === undefined || value === null || value === '' ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * Cheap non-cryptographic hash. The values here are long strings (a canvas data
 * URL runs to tens of KB) and only need to be a stable equality key — the
 * backend applies real hashing on top.
 */
function fastHash (input) {
  const text = String(input)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193)
    h2 = Math.imul(h2 + code, 0x85ebca6b) ^ (h2 >>> 13)
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'))
}

/**
 * Canvas rendering differs by GPU, driver, font rasterizer and OS. Two machines
 * with the same browser version usually still differ.
 */
function collectCanvas () {
  return safe(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 60
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.textBaseline = 'top'
    ctx.font = '14px "Arial"'
    ctx.fillStyle = '#f60'
    ctx.fillRect(ent(0), 0, 100, 20)
    ctx.fillStyle = '#069'
    ctx.fillText('Device signature ☁️', 2, 15)
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'
    ctx.fillText('Device signature ☁️', 4, 25)

    // Curves exercise the rasterizer differently from glyphs.
    ctx.globalCompositeOperation = 'multiply'
    ctx.beginPath()
    ctx.arc(50, 40, 18, 0, Math.PI * 2, true)
    ctx.closePath()
    ctx.fill()

    return fastHash(canvas.toDataURL())
  })
}

// Tiny indirection so the constant above is not folded oddly by minifiers that
// rewrite numeric literals in fillRect argument position.
function ent (n) { return n }

function collectWebgl () {
  return safe(() => {
    const canvas = document.createElement('canvas')
    // Cast: the `||` fallback widens the return to the RenderingContext union,
    // which has no WebGL methods. The runtime guard below is the real check.
    const gl = /** @type {WebGLRenderingContext|null} */ (
      canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    )
    if (!gl) return null

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER)
    return String(renderer || '').slice(0, 200)
  })
}

function collectWebglVendor () {
  return safe(() => {
    const canvas = document.createElement('canvas')
    const gl = /** @type {WebGLRenderingContext|null} */ (
      canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    )
    if (!gl) return null

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const vendor = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR)
    return String(vendor || '').slice(0, 120)
  })
}

/**
 * Audio pipeline output differs by platform DSP implementation.
 *
 * Uses OfflineAudioContext so nothing is played and no user gesture is needed.
 * Rendering is async, so this returns a promise; the collector awaits it.
 */
function collectAudio () {
  return new Promise((resolve) => {
    try {
      // webkitOfflineAudioContext is the Safari prefix; lib.dom declares neither
      // it nor a prefixed global, hence the cast.
      const Ctx = window.OfflineAudioContext
        || /** @type {any} */ (window).webkitOfflineAudioContext
      if (!Ctx) return resolve(null)

      const context = new Ctx(1, 5000, 44100)
      const oscillator = context.createOscillator()
      oscillator.type = 'triangle'
      oscillator.frequency.setValueAtTime(10000, context.currentTime)

      const compressor = context.createDynamicsCompressor()
      compressor.threshold.setValueAtTime(-50, context.currentTime)
      compressor.knee.setValueAtTime(40, context.currentTime)
      compressor.ratio.setValueAtTime(12, context.currentTime)
      compressor.attack.setValueAtTime(0, context.currentTime)
      compressor.release.setValueAtTime(0.25, context.currentTime)

      oscillator.connect(compressor)
      compressor.connect(context.destination)
      oscillator.start(0)

      // Never hang the collector on a context that refuses to render.
      const timer = setTimeout(() => resolve(null), 1000)

      context.oncomplete = (event) => {
        clearTimeout(timer)
        try {
          const channel = event.renderedBuffer.getChannelData(0)
          let sum = 0
          for (let i = 4500; i < 5000; i += 1) {
            const sample = channel[i]
            if (sample !== undefined) sum += Math.abs(sample)
          }
          resolve(fastHash(sum.toString()))
        } catch {
          resolve(null)
        }
      }
      context.startRendering()
    } catch {
      resolve(null)
    }
  })
}

/**
 * Which of a probe list of fonts are installed, measured by text width against
 * a fallback family. Installed-font sets vary a lot between machines.
 */
function collectFonts () {
  return safe(() => {
    const baseFonts = ['monospace', 'sans-serif', 'serif']
    const probes = [
      'Arial', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia',
      'Palatino', 'Garamond', 'Comic Sans MS', 'Trebuchet MS', 'Impact',
      'Tahoma', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Ubuntu',
      'Cantarell', 'Menlo', 'Monaco', 'Consolas', 'DejaVu Sans'
    ]
    const testString = 'mmmmmmmmmmlli'
    const testSize = '72px'

    const span = document.createElement('span')
    span.style.position = 'absolute'
    span.style.left = '-9999px'
    span.style.fontSize = testSize
    span.style.visibility = 'hidden'
    span.textContent = testString
    document.body.appendChild(span)

    try {
      const baseline = {}
      for (const base of baseFonts) {
        span.style.fontFamily = base
        baseline[base] = { w: span.offsetWidth, h: span.offsetHeight }
      }

      const detected = []
      for (const font of probes) {
        const matched = baseFonts.some((base) => {
          span.style.fontFamily = `"${font}",${base}`
          return span.offsetWidth !== baseline[base].w || span.offsetHeight !== baseline[base].h
        })
        if (matched) detected.push(font)
      }
      return detected.length > 0 ? fastHash(detected.join(',')) : null
    } finally {
      document.body.removeChild(span)
    }
  })
}

async function collectComponents () {
  const audio = await collectAudio()

  return {
    canvas: collectCanvas(),
    webgl: collectWebgl(),
    webglVendor: collectWebglVendor(),
    audio,
    fonts: collectFonts(),
    platform: safe(() => navigator.platform),
    hardwareConcurrency: safe(() => navigator.hardwareConcurrency),
    // Device Memory API: Chromium-only and not in lib.dom, so it is read
    // through a cast. `safe()` already swallows its absence at runtime.
    deviceMemory: safe(() => /** @type {any} */ (navigator).deviceMemory),
    colorDepth: safe(() => window.screen.colorDepth),
    // Physical screen, not the window — a resize must not change the signature.
    screen: safe(() => `${window.screen.width}x${window.screen.height}`),
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    touchSupport: safe(() => (('ontouchstart' in window) || navigator.maxTouchPoints > 0) ? '1' : '0')
  }
}

function encode (payload) {
  const json = JSON.stringify(payload)
  // btoa is latin1-only; encodeURIComponent round-trip keeps it safe for any
  // unicode that made it into a component value.
  return btoa(unescape(encodeURIComponent(json)))
}

/**
 * Kick off collection and cache the encoded header value.
 *
 * Safe to call repeatedly — the work happens once per tab.
 */
export function initDeviceSignature () {
  if (memoized) return memoized

  memoized = (async () => {
    try {
      const cached = sessionStorage.getItem(STORAGE_KEY)
      if (cached) return cached
    } catch {
      // sessionStorage unavailable (private mode, disabled cookies) — recompute.
    }

    try {
      const components = await collectComponents()
      const populated = Object.fromEntries(
        Object.entries(components).filter(([, value]) => value !== null && value !== undefined)
      )
      // Too little entropy to be worth sending; the backend would reject it.
      if (Object.keys(populated).length < 4) return null

      const encoded = encode({ v: VERSION, components: populated })
      try { sessionStorage.setItem(STORAGE_KEY, encoded) } catch { /* non-fatal */ }
      return encoded
    } catch {
      return null
    }
  })()

  return memoized
}

/**
 * The header value, or null if collection has not finished or failed.
 *
 * Deliberately synchronous: the axios request interceptor cannot await. The
 * first few calls after page load therefore go out without a signature, which
 * is fine — login and trading both happen well after collection completes, and
 * a missing signal is only ever a missing signal.
 */
let resolvedValue = null

export function getDeviceSignature () {
  if (resolvedValue) return resolvedValue
  const pending = initDeviceSignature()
  if (pending && typeof pending.then === 'function') {
    pending.then((value) => { resolvedValue = value }).catch(() => {})
  }
  return resolvedValue
}

/**
 * Awaitable variant, for registration — the signature matters most at signup and
 * that request is user-initiated, so waiting a few ms for it is acceptable.
 */
export async function getDeviceSignatureAsync () {
  if (resolvedValue) return resolvedValue
  resolvedValue = await initDeviceSignature()
  return resolvedValue
}

export const __testing = { fastHash, encode, collectComponents }
