// Backed by sessionStorage so a stashed value (e.g. a pending challenge
// selection) survives a real page reload or a detour through register/login,
// not just in-memory SPA navigation. Falls back to a plain in-JS object if
// storage access throws (strict privacy modes, some embedded webviews).
const fallbackStore = {}
let storageAvailable = true

try {
  const probeKey = '__memoryStore_probe__'
  window.sessionStorage.setItem(probeKey, '1')
  window.sessionStorage.removeItem(probeKey)
} catch {
  storageAvailable = false
}

export function getMemoryItem(key) {
  if (storageAvailable) {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      // fall through to in-memory store
    }
  }
  return Object.prototype.hasOwnProperty.call(fallbackStore, key) ? fallbackStore[key] : null
}

export function setMemoryItem(key, value) {
  const stringValue = String(value)
  if (storageAvailable) {
    try {
      window.sessionStorage.setItem(key, stringValue)
      return
    } catch {
      // fall through to in-memory store
    }
  }
  fallbackStore[key] = stringValue
}

export function removeMemoryItem(key) {
  if (storageAvailable) {
    try {
      window.sessionStorage.removeItem(key)
      return
    } catch {
      // fall through to in-memory store
    }
  }
  delete fallbackStore[key]
}

// Backed by localStorage, for state that should survive a closed tab and a
// logout/login cycle (e.g. a pinned watchlist) rather than just a reload.
const fallbackPersistentStore = {}
let persistentStorageAvailable = true

try {
  const probeKey = '__memoryStore_persistent_probe__'
  window.localStorage.setItem(probeKey, '1')
  window.localStorage.removeItem(probeKey)
} catch {
  persistentStorageAvailable = false
}

export function getPersistentItem(key) {
  if (persistentStorageAvailable) {
    try {
      return window.localStorage.getItem(key)
    } catch {
      // fall through to in-memory store
    }
  }
  return Object.prototype.hasOwnProperty.call(fallbackPersistentStore, key) ? fallbackPersistentStore[key] : null
}

export function setPersistentItem(key, value) {
  const stringValue = String(value)
  if (persistentStorageAvailable) {
    try {
      window.localStorage.setItem(key, stringValue)
      return
    } catch {
      // fall through to in-memory store
    }
  }
  fallbackPersistentStore[key] = stringValue
}

export function removePersistentItem(key) {
  if (persistentStorageAvailable) {
    try {
      window.localStorage.removeItem(key)
      return
    } catch {
      // fall through to in-memory store
    }
  }
  delete fallbackPersistentStore[key]
}
