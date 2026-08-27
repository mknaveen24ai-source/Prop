import React, { useEffect, useRef, useState } from 'react'
import { useApiState } from '../providers/ApiStateProvider'
import { applyServiceWorkerUpdate } from '../utils/registerServiceWorker'

/**
 * The one place the app tells a trader that what they are looking at may not be
 * current.
 *
 * `ApiStateProvider` has tracked `isOnline` since it was written, and until now
 * nothing read it -- the state was correct and invisible. That matters more here
 * than on most apps: every figure on a trading dashboard is a live number, and
 * a disconnected socket looks exactly like a quiet market.
 *
 * Two distinct messages, deliberately not merged:
 *
 *   offline       the numbers on screen are frozen and cannot be trusted.
 *   update ready  a deploy landed under an open tab. The shell on screen is
 *                 the previous build's.
 *
 * Pinned to the bottom rather than the top: the top of a phone screen already
 * carries the risk banner and the app chrome, and this needs to be noticed
 * without covering the price.
 */
export default function ConnectionStatusBar() {
  const { isOnline } = useApiState()
  const [updateReady, setUpdateReady] = useState(null)
  const wasOffline = useRef(false)
  const [reconnected, setReconnected] = useState(false)

  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true
      return undefined
    }
    if (!wasOffline.current) return undefined

    // Confirm the recovery rather than just removing the warning. A bar that
    // silently disappears leaves the trader unsure whether the figures are live
    // again or the warning simply gave up.
    const showTimer = setTimeout(() => setReconnected(true), 0)
    const timer = setTimeout(() => {
      setReconnected(false)
      wasOffline.current = false
    }, 4000)
    return () => {
      clearTimeout(showTimer)
      clearTimeout(timer)
    }
  }, [isOnline])

  useEffect(() => {
    const onUpdate = (event) => setUpdateReady(event.detail)
    window.addEventListener('propfirm:sw-update', onUpdate)
    return () => window.removeEventListener('propfirm:sw-update', onUpdate)
  }, [])

  if (!isOnline) {
    return (
      <div className="conn-bar conn-bar--offline" role="status" aria-live="assertive">
        <span className="conn-bar__dot" aria-hidden="true" />
        <span>Offline — prices and balances on this screen are not updating.</span>
      </div>
    )
  }

  if (reconnected) {
    return (
      <div className="conn-bar conn-bar--online" role="status" aria-live="polite">
        <span className="conn-bar__dot" aria-hidden="true" />
        <span>Back online. Live data resumed.</span>
      </div>
    )
  }

  if (updateReady) {
    return (
      <div className="conn-bar conn-bar--update" role="status" aria-live="polite">
        <span>A new version is available.</span>
        <button
          type="button"
          className="conn-bar__action"
          onClick={() => applyServiceWorkerUpdate(updateReady)}
        >
          Reload
        </button>
      </div>
    )
  }

  return null
}
