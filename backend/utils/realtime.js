let ioInstance = null

function registerIO(io) {
  ioInstance = io
}

function emitAdminEvent(eventName, payload = {}) {
  if (!ioInstance) return
  ioInstance.to('admin').emit(String(eventName), payload)
}

module.exports = {
  emitAdminEvent,
  registerIO
}
