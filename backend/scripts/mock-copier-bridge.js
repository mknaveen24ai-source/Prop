'use strict'

require('../loadEnv')

const net = require('net')
const { v4: uuidv4 } = require('uuid')

const PORT = parseInt(process.env.MT5_BRIDGE_PORT || '9999', 10)
const HOST = process.env.MT5_BRIDGE_BIND_HOST || '0.0.0.0'
const MODE = String(process.env.MOCK_BRIDGE_MODE || 'happy').trim().toLowerCase()

const DEFAULT_SYMBOL_CATALOG = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']
const DEFAULT_SYMBOL_CONSTRAINTS = {
  EURUSD: { minLot: 0.01, lotStep: 0.01 },
  GBPUSD: { minLot: 0.01, lotStep: 0.01 },
  XAUUSD: { minLot: 0.01, lotStep: 0.01 },
  XAGUSD: { minLot: 0.01, lotStep: 0.01 }
}

const followerState = new Map()
const retryOnceTracker = new Set()

function getFollowerKey(message = {}) {
  return String(message.bridge_target_key || message.follower_id || 'default').trim() || 'default'
}

function getFollowerSnapshot(key) {
  if (!followerState.has(key)) {
    followerState.set(key, {
      balance: 25000,
      equity: 25000,
      positions: [],
      pendingOrders: [],
      symbolCatalog: [...DEFAULT_SYMBOL_CATALOG],
      symbolConstraints: { ...DEFAULT_SYMBOL_CONSTRAINTS }
    })
  }
  return followerState.get(key)
}

function nextTicket(prefix) {
  return `${prefix}-${uuidv4().slice(0, 8)}`
}

function sendLine(socket, payload) {
  socket.write(`${JSON.stringify(payload)}\n`)
}

function ackBase(message) {
  return {
    correlation_id: message.correlation_id,
    bridge_timestamp: new Date().toISOString()
  }
}

function shouldRetryOnce(message) {
  if (MODE !== 'retry_once') return false
  const key = String(message.correlation_id || '')
  if (!key || retryOnceTracker.has(key)) return false
  retryOnceTracker.add(key)
  return true
}

function shouldRejectSpread(message) {
  return MODE === 'reject_spread' && String(message.event_type || '').toUpperCase() === 'OPEN_MARKET'
}

function applyOpenMarket(snapshot, message) {
  const ticket = nextTicket('pos')
  snapshot.positions.push({
    ticket,
    symbol: message.mapped_symbol,
    direction: message.direction,
    lots: Number(message.requested_lots || 0),
    stop_loss: message.sl ?? null,
    take_profit: message.tp ?? null,
    open_price: Number(message.pending_price || 1.1)
  })
  return {
    external_ticket: ticket,
    executed_price: Number(message.pending_price || 1.1),
    spread_points: 0.5
  }
}

function applyPlacePending(snapshot, message) {
  const orderId = nextTicket('ord')
  snapshot.pendingOrders.push({
    order_id: orderId,
    symbol: message.mapped_symbol,
    direction: message.direction,
    order_type: message.order_type,
    lots: Number(message.requested_lots || 0),
    pending_price: Number(message.pending_price || 1.1),
    stop_loss: message.sl ?? null,
    take_profit: message.tp ?? null
  })
  return {
    external_order_id: orderId,
    executed_price: Number(message.pending_price || 1.1),
    spread_points: 0.5
  }
}

function applyModifyPending(snapshot, message) {
  const order = snapshot.pendingOrders.find((item) => String(item.order_id) === String(message.external_order_id))
  if (!order) {
    return { error_code: 'ORDER_NOT_FOUND', error_message: 'Pending order not found' }
  }
  order.pending_price = Number(message.pending_price ?? order.pending_price)
  order.stop_loss = message.sl ?? order.stop_loss
  order.take_profit = message.tp ?? order.take_profit
  return {
    external_order_id: order.order_id,
    executed_price: Number(order.pending_price),
    spread_points: 0.4
  }
}

function applyCancelPending(snapshot, message) {
  const index = snapshot.pendingOrders.findIndex((item) => String(item.order_id) === String(message.external_order_id))
  if (index === -1) {
    return { error_code: 'ORDER_NOT_FOUND', error_message: 'Pending order not found' }
  }
  const [order] = snapshot.pendingOrders.splice(index, 1)
  return {
    external_order_id: order.order_id,
    executed_price: Number(order.pending_price),
    spread_points: 0.2
  }
}

function applyModifyPosition(snapshot, message) {
  const position = snapshot.positions.find((item) => String(item.ticket) === String(message.external_ticket))
  if (!position) {
    return { error_code: 'POSITION_NOT_FOUND', error_message: 'Position not found' }
  }
  position.stop_loss = message.sl ?? position.stop_loss
  position.take_profit = message.tp ?? position.take_profit
  return {
    external_ticket: position.ticket,
    executed_price: Number(position.open_price || 1.1),
    spread_points: 0.2
  }
}

function applyPartialClose(snapshot, message) {
  const position = snapshot.positions.find((item) => String(item.ticket) === String(message.external_ticket))
  if (!position) {
    return { error_code: 'POSITION_NOT_FOUND', error_message: 'Position not found' }
  }
  const closeLots = Number(message.requested_lots || 0)
  position.lots = Math.max(0, Number(position.lots || 0) - closeLots)
  if (position.lots <= 0.000001) {
    snapshot.positions = snapshot.positions.filter((item) => item.ticket !== position.ticket)
  }
  return {
    external_ticket: message.external_ticket,
    executed_price: Number(position.open_price || 1.1),
    spread_points: 0.2
  }
}

function applyClosePosition(snapshot, message) {
  const ticket = String(message.external_ticket || '')
  snapshot.positions = snapshot.positions.filter((item) => String(item.ticket) !== ticket)
  return {
    external_ticket: ticket || nextTicket('closed'),
    executed_price: 1.1,
    spread_points: 0.2
  }
}

function buildSnapshotPayload(message, snapshot) {
  return {
    type: 'snapshot',
    correlation_id: message.correlation_id,
    follower_id: message.follower_id || null,
    bridge_target_key: message.bridge_target_key || null,
    balance: snapshot.balance,
    equity: snapshot.equity,
    positions: snapshot.positions,
    pending_orders: snapshot.pendingOrders,
    symbol_catalog: snapshot.symbolCatalog,
    symbol_constraints: snapshot.symbolConstraints
  }
}

function handleCommand(socket, message) {
  const eventType = String(message.event_type || message.type || '').toUpperCase()
  const followerKey = getFollowerKey(message)
  const snapshot = getFollowerSnapshot(followerKey)

  if (eventType === 'HEARTBEAT') {
    sendLine(socket, {
      ...ackBase(message),
      type: 'heartbeat',
      status: 'heartbeat'
    })
    return
  }

  if (eventType === 'SNAPSHOT_REQUEST') {
    sendLine(socket, buildSnapshotPayload(message, snapshot))
    sendLine(socket, {
      ...ackBase(message),
      status: 'acknowledged',
      message: 'Snapshot sent'
    })
    return
  }

  if (shouldRetryOnce(message)) {
    sendLine(socket, {
      ...ackBase(message),
      status: 'retry',
      error_code: 'TRANSIENT',
      error_message: 'Mock transient retry'
    })
    return
  }

  if (shouldRejectSpread(message)) {
    sendLine(socket, {
      ...ackBase(message),
      status: 'failed',
      error_code: 'SPREAD_LIMIT',
      error_message: 'Mock spread rejection'
    })
    return
  }

  let result = {}
  if (eventType === 'OPEN_MARKET') {
    result = applyOpenMarket(snapshot, message)
  } else if (eventType === 'PLACE_PENDING') {
    result = applyPlacePending(snapshot, message)
  } else if (eventType === 'MODIFY_PENDING') {
    result = applyModifyPending(snapshot, message)
  } else if (eventType === 'CANCEL_PENDING') {
    result = applyCancelPending(snapshot, message)
  } else if (eventType === 'MODIFY_POSITION') {
    result = applyModifyPosition(snapshot, message)
  } else if (eventType === 'PARTIAL_CLOSE') {
    result = applyPartialClose(snapshot, message)
  } else if (eventType === 'CLOSE_POSITION') {
    result = applyClosePosition(snapshot, message)
  } else {
    sendLine(socket, {
      ...ackBase(message),
      status: 'failed',
      error_code: 'UNSUPPORTED',
      error_message: `Unsupported event_type ${eventType}`
    })
    return
  }

  if (result.error_code) {
    sendLine(socket, {
      ...ackBase(message),
      status: 'failed',
      error_code: result.error_code,
      error_message: result.error_message
    })
    return
  }

  sendLine(socket, {
    ...ackBase(message),
    status: 'acknowledged',
    ...result
  })
}

const server = net.createServer((socket) => {
  let buffer = ''
  console.log(`[mock-copier-bridge] client connected from ${socket.remoteAddress}:${socket.remotePort}`)

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const raw = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (raw) {
        try {
          const message = JSON.parse(raw)
          handleCommand(socket, message)
        } catch (error) {
          console.error('[mock-copier-bridge] invalid payload:', error.message)
        }
      }
      newlineIndex = buffer.indexOf('\n')
    }
  })

  socket.on('close', () => {
    console.log('[mock-copier-bridge] client disconnected')
  })

  socket.on('error', (error) => {
    console.error('[mock-copier-bridge] socket error:', error.message)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[mock-copier-bridge] listening on ${HOST}:${PORT} mode=${MODE}`)
})
