const memoryStore = {}

export function getMemoryItem(key) {
  return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null
}

export function setMemoryItem(key, value) {
  memoryStore[key] = String(value)
}

export function removeMemoryItem(key) {
  delete memoryStore[key]
}
