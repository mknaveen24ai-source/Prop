import assert from 'node:assert/strict'
import test from 'node:test'
import chartRouter = require('../routes/trades/charts')

type CandleRequest = Parameters<typeof chartRouter.__test__.candlesHandler>[0]
type CandleResponse = Parameters<typeof chartRouter.__test__.candlesHandler>[1]

interface CapturedResponse {
  response: CandleResponse
  statusCode: () => number
  body: () => unknown
}

function makeResponse(): CapturedResponse {
  let capturedStatus = 200
  let capturedBody: unknown
  const responseShape = {
    status(code: number) {
      capturedStatus = code
      return responseShape
    },
    json(value: unknown) {
      capturedBody = value
      return responseShape
    }
  }

  return {
    response: responseShape as unknown as CandleResponse,
    statusCode: () => capturedStatus,
    body: () => capturedBody
  }
}

async function request(query: Record<string, unknown>): Promise<CapturedResponse> {
  const captured = makeResponse()
  await chartRouter.__test__.candlesHandler(
    { query } as unknown as CandleRequest,
    captured.response
  )
  return captured
}

void test('candles route preserves its authentication middleware', () => {
  const stack = (chartRouter as unknown as {
    stack: Array<{
      route?: {
        path: string
        stack: Array<{ name: string }>
      }
    }>
  }).stack
  const candleRoute = stack.find((layer) => layer.route?.path === '/candles')
  assert.ok(candleRoute)
  assert.deepEqual(candleRoute.route?.stack.map((handler) => handler.name), [
    'authenticateToken',
    'candlesHandler'
  ])
})

void test('candles route preserves missing and invalid query responses', async () => {
  const missing = await request({})
  assert.equal(missing.statusCode(), 400)
  assert.deepEqual(missing.body(), { error: 'instrument and timeframe are required' })

  const invalidInstrument = await request({ instrument: 'INVALID', timeframe: '1M' })
  assert.equal(invalidInstrument.statusCode(), 400)
  assert.deepEqual(invalidInstrument.body(), { error: 'Invalid instrument' })

  const invalidTimeframe = await request({ instrument: 'EURUSD', timeframe: '7M' })
  assert.equal(invalidTimeframe.statusCode(), 400)
  assert.deepEqual(invalidTimeframe.body(), {
    error: 'Invalid timeframe. Use: 1M, 3M, 5M, 15M, 30M, 1H, 2H, 4H'
  })
})
