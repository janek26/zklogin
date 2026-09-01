import { describe, expect, it } from 'vitest'
import { decodeRevertReason } from '../aa/client'

describe('decodeRevertReason', () => {
  it('decodes the Error(string) payload from the ZKPassport verifier', () => {
    // 0x08c379a0 = Error(string), offset 0x20, len 0x21 = "Invalid certificate registry root"
    const data = '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000021496e76616c696420636572746966696361746520726567697374727920726f6f7400000000000000000000000000000000000000000000000000000000000000'
    expect(decodeRevertReason(data)).toBe('Invalid certificate registry root')
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
