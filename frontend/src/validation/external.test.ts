import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ExternalDataError, parseExternal, parseJsonResponse } from './external'
import { parseWireMoney } from './money'

describe('external runtime validation', () => {
  it('keeps external values unknown until a schema accepts them', () => {
    const schema = z.object({ id: z.string().uuid() })
    expect(parseExternal(schema, { id: 'f49d58a7-e004-4993-97ab-04157818b766' }, 'fixture')).toEqual({
      id: 'f49d58a7-e004-4993-97ab-04157818b766'
    })
    expect(() => parseExternal(schema, { id: 42 }, 'fixture')).toThrow(ExternalDataError)
  })

  it('validates parsed response JSON before returning it', async () => {
    const response = { json: async (): Promise<unknown> => ({ status: 'ok' }) }
    await expect(parseJsonResponse(response, z.object({ status: z.literal('ok') }), 'health response'))
      .resolves.toEqual({ status: 'ok' })
  })

  it('rejects numeric and exponent wire money instead of coercing it', () => {
    expect(parseWireMoney('0.000000000000000001').toFixed()).toBe('0.000000000000000001')
    expect(() => parseWireMoney(1.25)).toThrow('Invalid wire-format money')
    expect(() => parseWireMoney('1e3')).toThrow('Invalid wire-format money')
  })
})
