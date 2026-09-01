import { describe, expect, it } from 'vitest'
import { decodeRevertReason, extractRevertReason } from '../lib/utils'

const REVERT_HEX = '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000021496e76616c696420636572746966696361746520726567697374727920726f6f7400000000000000000000000000000000000000000000000000000000000000'

describe('decodeRevertReason', () => {
  it('decodes the Error(string) payload from the ZKPassport verifier', () => {
    expect(decodeRevertReason(REVERT_HEX)).toBe('Invalid certificate registry root')
  })

  it('decodes a generic revert reason', () => {
    const text = 'USER_OPERATION_REVERTED'
    const body = Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0')
    const data = '0x08c379a0' + '0000000000000000000000000000000000000000000000000000000000000020' + (text.length).toString(16).padStart(64, '0') + body
    expect(decodeRevertReason(data)).toBe(text)
  })

  it('returns null for non-Error(string) data', () => {
    expect(decodeRevertReason('0x1234')).toBeNull()
    expect(decodeRevertReason('0x')).toBeNull()
    expect(decodeRevertReason('')).toBeNull()
  })
})

describe('extractRevertReason', () => {
  it('reads a direct data field (viem JsonRpcError shape)', () => {
    expect(extractRevertReason({ data: REVERT_HEX })).toBe('Invalid certificate registry root')
  })

  it('walks nested cause chains (ZeroDev sponsor failure shape)', () => {
    const error = new Error('zd_sponsorUserOperation - execution reverted')
    const wrapped = new Error('sendUserOperation failed', { cause: error })
    ;(wrapped as unknown as Record<string, unknown>).cause = { cause: { data: REVERT_HEX } }
    expect(extractRevertReason(wrapped)).toBe('Invalid certificate registry root')
  })

  it('extracts hex embedded in a message string', () => {
    const err = new Error(`Execution reverted: ${REVERT_HEX}`)
    expect(extractRevertReason(err)).toBe('Invalid certificate registry root')
  })

  it('extracts an already-decoded reason from viem-style text', () => {
    const err = new Error('The contract function "execute" reverted with the following reason:\nInvalid certificate registry root')
    expect(extractRevertReason(err)).toBe('Invalid certificate registry root')
  })

  it('falls back to null for unrelated errors', () => {
    expect(extractRevertReason(null)).toBeNull()
    expect(extractRevertReason(undefined)).toBeNull()
    expect(extractRevertReason(new Error('network error'))).toBeNull()
    expect(extractRevertReason('plain string')).toBeNull()
  })

  it('does not loop forever on cyclic cause chains', () => {
    const a: Record<string, unknown> = { message: 'x' }
    const b: Record<string, unknown> = { message: 'y', cause: a }
    a.cause = b
    expect(extractRevertReason(a)).toBeNull()
  })
})
