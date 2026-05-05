let ioInstance = null

function registerIO(io) {
  ioInstance = io
}

function emitAdminEvent(eventName, payload = {}, tenantId = null) {
  if (!ioInstance) return
  const name = String(eventName)
  const normalizedTenantId = parseInt(tenantId, 10)

  if (Number.isFinite(normalizedTenantId) && normalizedTenantId > 0) {
    ioInstance.to(`admin:tenant:${normalizedTenantId}`).emit(name, payload)
    ioInstance.to('admin:super').emit(name, payload)
    return
  }

  ioInstance.to('admin').emit(name, payload)
  ioInstance.to('admin:super').emit(name, payload)
}

module.exports = {
  emitAdminEvent,
  registerIO
}
