import { z } from 'zod'

export const instrumentSubscriptionsSchema = z.array(
  z.string().trim().min(1).max(32)
).max(100)

export const joinAccountSchema = z.union([
  z.literal('admin'),
  z.string().uuid()
])

export const conversationIdSchema = z.coerce.number().int().positive()

export const typingStartSchema = z.object({
  conversationId: conversationIdSchema,
  isTyping: z.boolean()
})
