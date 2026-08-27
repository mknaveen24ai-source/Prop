import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { Server } from 'socket.io'

type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

let ioInstance: TypedServer | null = null

function registerIO(io: TypedServer): void {
  ioInstance = io
}

function emitAdminEvent<EventName extends keyof ServerToClientEvents>(
  eventName: EventName,
  ...args: Parameters<ServerToClientEvents[EventName]>
): void {
  if (!ioInstance) return
  ioInstance.to('admin').emit(eventName, ...args)
}

/**
 * Currently connected sockets, or null when Socket.IO has not been registered
 * (tests, the email worker). Null rather than 0 so a caller can tell "not
 * running here" apart from "running with nobody connected".
 */
function getConnectedSocketCount(): number | null {
  if (!ioInstance) return null
  return ioInstance.engine?.clientsCount ?? ioInstance.sockets?.sockets?.size ?? null
}

export {
  emitAdminEvent,
  registerIO,
  getConnectedSocketCount
}
