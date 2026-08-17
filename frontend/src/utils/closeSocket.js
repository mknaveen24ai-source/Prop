/**
 * Tear down a Socket.IO client without the console noise.
 *
 * Calling `socket.disconnect()` while the underlying WebSocket is still
 * handshaking makes the browser log:
 *
 *   WebSocket connection to 'ws://host/socket.io/?EIO=4&transport=websocket'
 *   failed: WebSocket is closed before the connection is established.
 *
 * React StrictMode hits this on every mount in development — the effect runs,
 * the cleanup runs, the effect runs again, and that first socket is always
 * closed mid-handshake. Nothing is broken by it, but it buries real errors.
 *
 * Dropping the listeners makes the socket inert immediately (no handler can
 * fire against an unmounted component); the close itself waits until the
 * handshake resolves one way or the other. `graceMs` is the backstop for a
 * server that never answers, so an unreachable backend can't leave a socket
 * reconnecting forever.
 */
export default function closeSocket(socket, graceMs = 5000) {
  if (!socket) return

  // Removes every listener, ours and the caller's, including any 'connect'
  // handler — so the once() below is registered after this, not before.
  socket.off()

  if (socket.connected) {
    socket.disconnect()
    return
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    socket.disconnect()
  }

  const timer = setTimeout(close, graceMs)
  socket.once('connect', close)
  socket.once('connect_error', close)
}
