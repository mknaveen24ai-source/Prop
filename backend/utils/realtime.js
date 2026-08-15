let ioInstance = null

function registerIO(io) {
  ioInstance = io
}

function emitAdminEvent(eventName, payload = {}) {
  if (!ioInstance) return
  ioInstance.to('admin').emit(String(eventName), payload)
}

/**
 * Currently connected sockets, or null when Socket.IO has not been registered
 * (tests, the email worker). Null rather than 0 so a caller can tell "not
 * running here" apart from "running with nobody connected".
 */
function getConnectedSocketCount() {
  if (!ioInstance) return null
  return ioInstance.engine?.clientsCount ?? ioInstance.sockets?.sockets?.size ?? null
}

module.exports = {
  emitAdminEvent,
  registerIO,
  getConnectedSocketCount
}
