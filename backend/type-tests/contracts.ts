import type {
  ApplyEnforcementResponseDto,
  DecimalString,
  DeviceGraphResponseDto,
  ServerToClientEvents
} from '@propfirm/contracts'
import type { decimalStringSchema, serializeDecimal } from '../utils/money'

type SchemaOutput = ReturnType<typeof decimalStringSchema.parse>
type SerializedOutput = ReturnType<typeof serializeDecimal>
type Assert<T extends true> = T
type IsAssignable<From, To> = [From] extends [To] ? true : false
type SchemaMatchesDto = Assert<IsAssignable<SchemaOutput, DecimalString>>
type SerializerMatchesDto = Assert<IsAssignable<SerializedOutput, DecimalString>>

type EnforcementEventPayload = Parameters<ServerToClientEvents['admin_enforcement_event']>[0]
type ContractChecks = [
  DecimalString,
  SchemaOutput,
  ApplyEnforcementResponseDto,
  DeviceGraphResponseDto,
  EnforcementEventPayload,
  SchemaMatchesDto,
  SerializerMatchesDto
]

export type { ContractChecks }
